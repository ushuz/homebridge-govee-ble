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
 * exclusive lock *directory* under os.tmpdir() so node-ble plugins share one
 * bluez adapter without overlapping scan/connect — works across processes
 * (child bridges) and within one homebridge process.
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
/** do not steal unreadable locks younger than this (create→write race) */
const UNREADABLE_GRACE_MS = 5_000

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

function isStale(dir: string, payload: LockPayload | null): boolean {
  if (!existsSync(dir)) {
    return true
  }
  if (!payload) {
    // empty or mid-write lock: busy until grace, then reclaim
    return dirAgeMs(dir) > UNREADABLE_GRACE_MS
  }
  // never age-steal a live holder (scans/connects may exceed any fixed ttl)
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
): boolean {
  if (!isStale(dir, observed)) {
    return false
  }

  const current = readLock(dir)
  if (!sameHolder(observed, current)) {
    return false
  }
  if (!isStale(dir, current)) {
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
 * run `fn` while holding the shared ble adapter lock.
 * other plugins using the same protocol wait until release.
 */
export async function withBleAdapterLock<T>(
  options: BleAdapterLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const owner = options.owner
  const hciDeviceId = options.hciDeviceId ?? 0
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const log = options.log
  const dir = lockDir(hciDeviceId)
  const deadline = Date.now() + acquireTimeoutMs
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
    if (trySteal(dir, holder, log)) {
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
    `timed out after ${acquireTimeoutMs}ms waiting for ble adapter lock`
    + ` (hci${hciDeviceId}, held by ${heldBy})`,
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
