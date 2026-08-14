import { AsyncLocalStorage } from "node:async_hooks"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * cross-plugin ble adapter mutex (protocol v1).
 *
 * in-process fifo queue plus exclusive lock *directory* under os.tmpdir().
 * same-process plugins line up; the file lock only serializes child bridges /
 * other processes. nested calls in the same op re-enter.
 *
 * - `mkdir` is atomic exclusive create
 * - stale reclaim uses `rename` of the lock dir (only one waiter wins)
 * - release requires the acquisition token (not just owner+pid)
 * - live holders are never age-stolen (long scans must not be interrupted)
 *
 * keep in sync with @ushuz/homebridge-airthings-ble `src/ble/adapterLock.ts`
 * (module format differs: this package is cjs, airthings is esm).
 */

export const BLE_ADAPTER_LOCK_PROTOCOL = 1 as const

export interface BleAdapterLockOptions {
  /** stable plugin id, e.g. "govee-ble" */
  owner: string
  /** noble hci index; lock is per-adapter */
  hciDeviceId?: number
  /** max time to wait for the lock (ms) */
  acquireTimeoutMs?: number
  /**
   * reserved for compatibility; live holders are never age-stolen.
   * dead/unreadable locks are reclaimed after grace / process death.
   */
  staleMs?: number
  /** poll interval while waiting (ms) */
  pollIntervalMs?: number
  /** steal a same-pid lock older than this (default 90s); hung dbus ops */
  sameProcessHungMs?: number
  log?: {
    debug?: (message: string, ...args: unknown[]) => void
    warn?: (message: string, ...args: unknown[]) => void
    info?: (message: string, ...args: unknown[]) => void
  }
}

interface LockPayload {
  v: typeof BLE_ADAPTER_LOCK_PROTOCOL
  owner: string
  pid: number
  acquiredAt: string
  token: string
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 200
/** in-process fifo tail per adapter */
const queueTail = new Map<number, Promise<void>>()
/** owner currently running in this process, per adapter */
const queueOwner = new Map<number, string>()
/** true while an op from this queue item is on the stack */
const opContext = new AsyncLocalStorage<true>()
/** do not steal unreadable locks younger than this (create→write race) */
const UNREADABLE_GRACE_MS = 5_000
/** same-process hold older than this is a hung owner (dbus death); steal it */
const DEFAULT_SAME_PROCESS_HUNG_MS = 90_000

function lockDir(hciDeviceId: number): string {
  return join(tmpdir(), `homebridge-ble-hci${hciDeviceId}.lock`)
}

function ownerPath(dir: string): string {
  return join(dir, "owner.json")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock(dir: string): LockPayload | null {
  try {
    const raw = readFileSync(ownerPath(dir), "utf8")
    const parsed = JSON.parse(raw) as Partial<LockPayload>
    if (
      parsed.v !== BLE_ADAPTER_LOCK_PROTOCOL
      || typeof parsed.owner !== "string"
      || typeof parsed.pid !== "number"
      || typeof parsed.acquiredAt !== "string"
      || typeof parsed.token !== "string"
    ) {
      return null
    }
    return parsed as LockPayload
  } catch {
    return null
  }
}

function dirAgeMs(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function lockAgeMs(dir: string, payload: LockPayload | null): number {
  if (payload) {
    const started = Date.parse(payload.acquiredAt)
    if (Number.isFinite(started)) {
      return Date.now() - started
    }
  }
  return dirAgeMs(dir)
}

function isStale(
  dir: string,
  payload: LockPayload | null,
  sameProcessHungMs = DEFAULT_SAME_PROCESS_HUNG_MS,
): boolean {
  if (!existsSync(dir)) {
    return true
  }
  if (!payload) {
    // empty or mid-write lock: busy until grace, then reclaim
    return dirAgeMs(dir) > UNREADABLE_GRACE_MS
  }
  // same-process hold that never finished (destroyed dbus bus) — steal
  if (payload.pid === process.pid && lockAgeMs(dir, payload) > sameProcessHungMs) {
    return true
  }
  // never age-steal a live holder in another process
  return !isProcessAlive(payload.pid)
}

function sameHolder(a: LockPayload | null, b: LockPayload | null): boolean {
  if (!a && !b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return a.token === b.token && a.pid === b.pid && a.owner === b.owner
}

/**
 * reclaim only if the observed holder is still present and still stale.
 * rename is the atomic handoff — only one waiter can rename the lock dir away.
 */
function trySteal(
  dir: string,
  observed: LockPayload | null,
  log?: BleAdapterLockOptions["log"],
  sameProcessHungMs = DEFAULT_SAME_PROCESS_HUNG_MS,
): boolean {
  if (!isStale(dir, observed, sameProcessHungMs)) {
    return false
  }

  const current = readLock(dir)
  if (!sameHolder(observed, current)) {
    return false
  }
  if (!isStale(dir, current, sameProcessHungMs)) {
    return false
  }

  const reclaim = `${dir}.reclaim.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  try {
    renameSync(dir, reclaim)
  } catch {
    // lost the race to another waiter (or holder released)
    return false
  }

  try {
    rmSync(reclaim, { recursive: true, force: true })
  } catch {
    // ignore cleanup failure; path is no longer the active lock
  }

  log?.warn?.(
    "stole stale ble adapter lock"
    + (observed ? ` (was ${observed.owner} pid=${observed.pid})` : " (unreadable)"),
  )
  return true
}

/** @returns acquisition token, or null if lock is held */
function tryAcquire(dir: string, owner: string): string | null {
  try {
    mkdirSync(tmpdir(), { recursive: true })
    mkdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      return null
    }
    throw err
  }

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const payload: LockPayload = {
    v: BLE_ADAPTER_LOCK_PROTOCOL,
    owner,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token,
  }
  try {
    writeFileSync(ownerPath(dir), `${JSON.stringify(payload)}\n`, "utf8")
    return token
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw err
  }
}

function release(dir: string, owner: string, token: string): void {
  const payload = readLock(dir)
  if (!payload) {
    return
  }
  if (payload.owner !== owner || payload.pid !== process.pid || payload.token !== token) {
    return
  }

  try {
    unlinkSync(ownerPath(dir))
  } catch {
    // ignore
  }
  try {
    rmdirSync(dir)
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * run `fn` as the next ble op on this adapter.
 * same process: fifo queue (nested calls re-enter).
 * other processes: file lock after this process reaches the head.
 */
export async function withBleAdapterLock<T>(
  options: BleAdapterLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (opContext.getStore()) {
    return fn()
  }

  const owner = options.owner
  const hciDeviceId = options.hciDeviceId ?? 0
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const log = options.log
  const deadline = Date.now() + acquireTimeoutMs

  const prev = queueTail.get(hciDeviceId) ?? Promise.resolve()
  let releaseQueue!: () => void
  const mine = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  queueTail.set(
    hciDeviceId,
    prev.then(() => mine, () => mine),
  )

  const ahead = queueOwner.get(hciDeviceId)
  if (ahead) {
    log?.info?.(`ble op queued behind ${ahead}`)
  }

  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      prev,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `timed out after ${acquireTimeoutMs}ms waiting for ble adapter queue`
              + ` (hci${hciDeviceId})`,
            ),
          )
        }, Math.max(0, deadline - Date.now()))
      }),
    ])
  } catch (err) {
    releaseQueue()
    throw err
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }

  queueOwner.set(hciDeviceId, owner)
  try {
    return await opContext.run(true, () => withFileLock(options, fn, deadline))
  } finally {
    if (queueOwner.get(hciDeviceId) === owner) {
      queueOwner.delete(hciDeviceId)
    }
    releaseQueue()
  }
}

async function withFileLock<T>(
  options: BleAdapterLockOptions,
  fn: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const owner = options.owner
  const hciDeviceId = options.hciDeviceId ?? 0
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const log = options.log
  const dir = lockDir(hciDeviceId)
  let waited = false
  let loggedWait = false

  while (Date.now() < deadline) {
    const token = tryAcquire(dir, owner)
    if (token) {
      if (waited) {
        log?.debug?.(`acquired ble adapter lock as ${owner}`)
      }
      try {
        return await fn()
      } finally {
        release(dir, owner, token)
      }
    }

    const holder = readLock(dir)
    if (trySteal(dir, holder, log, options.sameProcessHungMs)) {
      continue
    }

    waited = true
    if (!loggedWait) {
      loggedWait = true
      const heldBy = holder
        ? `${holder.owner} pid=${holder.pid}`
        : "unknown"
      log?.info?.(`ble adapter busy (held by ${heldBy}); waiting...`)
    }
    await sleep(pollIntervalMs)
  }

  const holder = readLock(dir)
  const heldBy = holder ? `${holder.owner} pid=${holder.pid}` : "unknown"
  throw new Error(
    `timed out after ${options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS}ms`
    + ` waiting for ble adapter lock (hci${hciDeviceId}, held by ${heldBy})`,
  )
}

/** test helper: lock path for a given hci id */
export function bleAdapterLockPath(hciDeviceId = 0): string {
  return lockDir(hciDeviceId)
}

/** resolve hci id from explicit config or NOBLE_HCI_DEVICE_ID env */
export function resolveHciDeviceId(explicit?: number): number {
  if (explicit !== undefined && explicit !== null && Number.isFinite(explicit)) {
    return Math.max(0, Math.trunc(explicit))
  }
  const fromEnv = Number(process.env.NOBLE_HCI_DEVICE_ID)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return Math.trunc(fromEnv)
  }
  return 0
}
