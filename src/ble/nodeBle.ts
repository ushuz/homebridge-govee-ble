/**
 * thin wrappers around node-ble (bluez/dbus).
 * linux-only; pure js — no hci socket, so peers can share the adapter.
 *
 * keep in sync with @ushuz/homebridge-airthings-ble `src/ble/nodeBle.ts`
 * (module format differs: this package is cjs, airthings is esm).
 */

// node-ble is cjs (`export =`)
const nodeBle = require("node-ble") as {
  createBluetooth: () => {
    bluetooth: NodeBleBluetooth
    destroy: () => void
  }
}

export interface NodeBleBluetooth {
  adapters(): Promise<string[]>
  defaultAdapter(): Promise<NodeBleAdapter>
  getAdapter(adapter: string): Promise<NodeBleAdapter>
}

export interface NodeBleAdapter {
  getAddress(): Promise<string>
  getName(): Promise<string>
  isPowered(): Promise<boolean>
  isDiscovering(): Promise<boolean>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<string[]>
  getDevice(address: string): Promise<NodeBleDevice>
  waitDevice(address: string, timeout?: number, discoveryInterval?: number): Promise<NodeBleDevice>
}

export interface NodeBleDevice {
  getName(): Promise<string>
  getAddress(): Promise<string>
  getAlias(): Promise<string>
  getRSSI(): Promise<number | string>
  getManufacturerData(): Promise<Record<string, unknown> | null>
  isConnected(): Promise<boolean | string>
  connect(): Promise<void>
  disconnect(): Promise<void>
  gatt(): Promise<NodeBleGattServer>
  on(event: "connect" | "disconnect", listener: (...args: unknown[]) => void): this
  removeListener(event: string, listener: (...args: unknown[]) => void): this
}

export interface NodeBleGattServer {
  services(): Promise<string[]>
  getPrimaryService(uuid: string): Promise<NodeBleGattService>
}

export interface NodeBleGattService {
  getUUID(): Promise<string>
  characteristics(): Promise<string[]>
  getCharacteristic(uuid: string): Promise<NodeBleGattCharacteristic>
}

export interface NodeBleGattCharacteristic {
  getUUID(): Promise<string>
  readValue(offset?: number): Promise<Buffer>
  writeValue(buffer: Buffer, optionsOrOffset?: number | { offset?: number, type?: string }): Promise<void>
  writeValueWithoutResponse(buffer: Buffer, offset?: number): Promise<void>
  writeValueWithResponse(buffer: Buffer, offset?: number): Promise<void>
  startNotifications(): Promise<void>
  stopNotifications(): Promise<void>
  on(event: "valuechanged", listener: (buffer: Buffer) => void): this
  removeListener(event: "valuechanged", listener: (buffer: Buffer) => void): this
  off?(event: "valuechanged", listener: (buffer: Buffer) => void): this
}

export interface BleBus {
  adapter: NodeBleAdapter
  adapterName: string
  destroy(): void
}

/** injectable factory for tests */
export type BleBusFactory = (hciDeviceId: number) => Promise<BleBus>

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Device = require("node-ble/src/Device") as new (
  dbus: unknown,
  adapter: string,
  device: string,
) => NodeBleDevice
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BusHelper = require("node-ble/src/BusHelper") as {
  prototype: { children: () => Promise<string[]>, _prepare: () => Promise<void> }
  buildChildren: (path: string, nodes: string[]) => string[]
}

let busHelperPatched = false

/** open dbus connection and bind the configured hciN adapter (no silent fallback) */
export async function openBleBus(hciDeviceId = 0): Promise<BleBus> {
  const { bluetooth, destroy } = nodeBle.createBluetooth()
  // node-ble does not handle dbus 'error'; unhandled emitters crash the process
  const dbus = (bluetooth as { dbus?: { on?: (event: string, cb: (err: Error) => void) => void } }).dbus
  if (dbus?.on) {
    dbus.on("error", (err: Error) => {
      // do not destroy() — that orphans an in-flight adapter lock
      process.stderr.write(`[node-ble] dbus error: ${err?.message || err}\n`)
    })
  }
  try {
    const adapters = await bluetooth.adapters()
    const preferred = `hci${hciDeviceId}`
    if (!adapters.includes(preferred)) {
      throw new Error(
        `bluetooth adapter ${preferred} not found via bluez`
        + (adapters.length ? ` (available: ${adapters.join(", ")})` : ""),
      )
    }
    const adapter = await bluetooth.getAdapter(preferred)
    if (!(await adapter.isPowered())) {
      throw new Error(`bluetooth adapter ${preferred} is not powered`)
    }
    patchBusHelperChildren()
    patchGattServerInit()
    patchAdapterDeviceCache(adapter)
    return { adapter, adapterName: preferred, destroy }
  } catch (err) {
    try {
      destroy()
    } catch {
      // ignore
    }
    throw err
  }
}

/**
 * node-ble BusHelper.children() rebuilds a dbus-next ProxyObject every call.
 * each new proxy adds AddMatch rules until dbus hits max_match_rules (2048).
 * reuse the existing proxy and refresh the child list via introspect.
 */
function patchBusHelperChildren(): void {
  if (busHelperPatched) {
    return
  }
  BusHelper.prototype.children = async function childrenReuseProxy(this: {
    _ready?: boolean
    _prepare: () => Promise<void>
    _objectProxy?: {
      nodes?: string[]
      interfaces?: Record<string, { Introspect?: () => Promise<string> }>
      getInterface?: (name: string) => { Introspect: () => Promise<string> }
    }
    object: string
  }): Promise<string[]> {
    if (!this._ready) {
      await this._prepare()
    }
    const xml = await introspectXml(this)
    if (this._objectProxy) {
      this._objectProxy.nodes = childPathsFromIntrospect(this.object, xml)
    }
    return BusHelper.buildChildren(this.object, this._objectProxy?.nodes ?? [])
  }
  busHelperPatched = true
}

async function introspectXml(helper: {
  _objectProxy?: {
    interfaces?: Record<string, { Introspect?: () => Promise<string> }>
    getInterface?: (name: string) => { Introspect: () => Promise<string> }
  }
}): Promise<string> {
  const proxy = helper._objectProxy
  if (!proxy) {
    return "<node></node>"
  }
  const named = proxy.interfaces?.["org.freedesktop.DBus.Introspectable"]
  if (named?.Introspect) {
    return named.Introspect()
  }
  try {
    const iface = proxy.getInterface?.("org.freedesktop.DBus.Introspectable")
    if (iface?.Introspect) {
      return iface.Introspect()
    }
  } catch {
    // ignore
  }
  return "<node></node>"
}

/** parse immediate child object paths from introspect xml */
export function childPathsFromIntrospect(parentPath: string, xml: string): string[] {
  const paths: string[] = []
  const re = /<node\s+name="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const name = match[1]
    if (!name || name.includes("/")) {
      continue
    }
    paths.push(`${parentPath}/${name}`)
  }
  return paths
}

function patchAdapterDeviceCache(adapter: NodeBleAdapter): void {
  const anyAdapter = adapter as NodeBleAdapter & {
    dbus?: unknown
    adapter?: string
    __deviceCache?: Map<string, NodeBleDevice>
  }
  const cache = anyAdapter.__deviceCache ?? new Map<string, NodeBleDevice>()
  anyAdapter.__deviceCache = cache
  const adapterName = anyAdapter.adapter ?? "hci0"

  adapter.getDevice = async (uuid: string) => {
    const formatted = formatBleAddress(uuid)
    const listed = await adapter.devices()
    const onBus = listed.some((address) => formatBleAddress(address) === formatted)
    if (!onBus) {
      cache.delete(formatted)
      throw new Error("Device not found")
    }
    const existing = cache.get(formatted)
    if (existing) {
      return existing
    }
    const serialized = `dev_${formatted.toUpperCase().replace(/:/g, "_")}`
    const device = hardenDevice(new Device(anyAdapter.dbus, adapterName, serialized))
    cache.set(formatted, device)
    return device
  }
}

export function forgetCachedDevice(adapter: NodeBleAdapter, address: string): void {
  const cache = (adapter as NodeBleAdapter & {
    __deviceCache?: Map<string, NodeBleDevice>
  }).__deviceCache
  cache?.delete(formatBleAddress(address))
}

export function isMissingBluezInterface(error: unknown): boolean {
  return /interface not found in proxy object/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

/**
 * node-ble only subscribes to Connected in connect(), and connect() is a
 * no-op here when BlueZ already reports connected. Without this watch the
 * controller never hears a later disconnect and keeps writing a dead GATT
 * characteristic.
 */
export function hardenDevice(device: NodeBleDevice): NodeBleDevice {
  const anyDevice = device as NodeBleDevice & {
    __hardened?: boolean
    __watchInstalled?: boolean
    emit?: (event: "connect" | "disconnect", payload: { connected: boolean }) => void
    helper?: {
      removeListeners?: () => void
      removeAllListeners?: (event: string) => void
      on?: (
        event: string,
        listener: (propertiesChanged: { Connected?: { value?: unknown } }) => void,
      ) => void
    }
  }
  if (anyDevice.__hardened) {
    return device
  }
  anyDevice.__hardened = true

  const origConnect = device.connect.bind(device)
  const origDisconnect = device.disconnect.bind(device)
  const origGatt = device.gatt.bind(device)
  let gattCached: NodeBleGattServer | undefined
  const dropGatt = () => {
    gattCached = undefined
  }
  device.connect = async () => {
    const connected = await isDeviceConnected(device)
    if (!connected) {
      dropGatt()
      try {
        anyDevice.helper?.removeAllListeners?.("PropertiesChanged")
      } catch {
        // ignore
      }
      anyDevice.__watchInstalled = false
      await origConnect()
      return
    }
    installConnectedWatch(anyDevice, dropGatt)
  }
  device.disconnect = async () => {
    try {
      await origDisconnect()
    } finally {
      dropGatt()
      try {
        anyDevice.helper?.removeListeners?.()
      } catch {
        // ignore
      }
    }
  }

  device.gatt = async () => {
    if (gattCached) {
      try {
        const services = await gattCached.services()
        if (services.length > 0) {
          return gattCached
        }
      } catch {
        gattCached = undefined
      }
    }
    gattCached = await origGatt()
    return gattCached
  }

  return device
}

function installConnectedWatch(
  device: NodeBleDevice & {
    __watchInstalled?: boolean
    emit?: (event: "connect" | "disconnect", payload: { connected: boolean }) => void
    helper?: {
      on?: (
        event: string,
        listener: (propertiesChanged: { Connected?: { value?: unknown } }) => void,
      ) => void
    }
  },
  onDisconnect: () => void,
): void {
  if (device.__watchInstalled || !device.helper?.on || !device.emit) {
    return
  }
  device.__watchInstalled = true
  const emit = device.emit.bind(device)
  device.helper.on("PropertiesChanged", (propertiesChanged) => {
    if (!propertiesChanged || !("Connected" in propertiesChanged)) {
      return
    }
    const value = propertiesChanged.Connected?.value
    if (value) {
      emit("connect", { connected: true })
    } else {
      onDisconnect()
      emit("disconnect", { connected: false })
    }
  })
}

async function isDeviceConnected(device: NodeBleDevice): Promise<boolean> {
  try {
    const value = await device.isConnected()
    return value === true || value === "true"
  } catch {
    return false
  }
}

/**
 * bluez manufacturer data is { [companyId]: Buffer }.
 * reconstruct classic ad payload (company id le + payload) for parsers.
 */
export function manufacturerPayloads(
  mfg: Record<string, unknown> | null | undefined,
): Buffer[] {
  if (!mfg) {
    return []
  }
  const out: Buffer[] = []
  for (const [id, value] of Object.entries(mfg)) {
    const companyId = Number(id)
    if (!Number.isFinite(companyId)) {
      continue
    }
    const payload = toBuffer(value)
    if (!payload) {
      continue
    }
    const buf = Buffer.allocUnsafe(2 + payload.length)
    buf.writeUInt16LE(companyId & 0xffff, 0)
    payload.copy(buf, 2)
    out.push(buf)
  }
  return out
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data)
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  return null
}

export function normalizeBleAddress(address: string): string {
  // accept aa:bb:..., aa-bb-..., or aabbccddeeff
  const hex = address.trim().toLowerCase().replace(/[^0-9a-f]/g, "")
  if (hex.length === 12) {
    return hex.match(/.{2}/g)!.join(":")
  }
  return address.trim().toLowerCase().replace(/-/g, ":")
}

/** colon-separated uppercase form used by some bluez paths */
export function formatBleAddress(address: string): string {
  return normalizeBleAddress(address).toUpperCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const GATT_RESOLVE_TIMEOUT_MS = 10_000
let gattResolveTimeoutMs = GATT_RESOLVE_TIMEOUT_MS
let gattServerPatched = false

/**
 * Resolve when `read()` is true, or when `subscribe` reports a truthy value.
 * Subscribes before the first read so a change between a check and a signal
 * listener is not lost. Polls because BlueZ sometimes never emits the signal.
 * Rejects on timeout instead of waiting forever.
 */
export async function waitForTruthyProperty(
  read: () => Promise<unknown>,
  subscribe: (onValue: (value: unknown) => void) => () => void,
  timeoutMs: number,
  timeoutMessage: string,
  pollMs = 200,
): Promise<void> {
  let unsubscribe = () => {}
  let timer: NodeJS.Timeout | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let settled = false
  const isTruthy = (value: unknown) => value === true || value === "true"

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        if (pollTimer) {
          clearTimeout(pollTimer)
        }
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      try {
        unsubscribe = subscribe((value) => {
          if (isTruthy(value)) {
            finish()
          }
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }

      timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs)

      const poll = () => {
        if (settled) {
          return
        }
        read().then((value) => {
          if (settled) {
            return
          }
          if (isTruthy(value)) {
            finish()
            return
          }
          pollTimer = setTimeout(poll, pollMs)
        }).catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)))
        })
      }
      poll()
    })
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    if (pollTimer) {
      clearTimeout(pollTimer)
    }
    try {
      unsubscribe()
    } catch {
      // ignore
    }
  }
}

/**
 * node-ble GattServer.init() reads ServicesResolved and, if false, waits for
 * PropertiesChanged with no timeout. If the property flips true before that
 * listener is armed, init never returns and every command times out.
 */
export function patchGattServerInit(timeoutMs = GATT_RESOLVE_TIMEOUT_MS): void {
  gattResolveTimeoutMs = timeoutMs
  if (gattServerPatched) {
    return
  }
  gattServerPatched = true

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const GattServer = require("node-ble/src/GattServer") as {
    prototype: { init: (this: GattServerLike) => Promise<void> }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const GattService = require("node-ble/src/GattService") as new (
    dbus: unknown,
    adapter: string,
    device: string,
    service: string,
  ) => {
    getUUID: () => Promise<string>
    init: () => Promise<void>
  }

  GattServer.prototype.init = async function initRaceSafe(this: GattServerLike): Promise<void> {
    this._services = {}
    const helper = this.helper
    // prop() builds the Properties proxy. Subscribe only after that exists.
    try {
      await helper.prop("ServicesResolved")
    } catch {
      // the wait below surfaces a persistent read failure
    }

    await waitForTruthyProperty(
      () => helper.prop("ServicesResolved"),
      (onValue) => {
        const proxy = helper._propsProxy
        if (!proxy?.on) {
          return () => {}
        }
        const listener = (iface: string, changed: Record<string, { value?: unknown }>) => {
          if (iface !== helper.iface || !changed || !("ServicesResolved" in changed)) {
            return
          }
          onValue(changed.ServicesResolved?.value)
        }
        proxy.on("PropertiesChanged", listener)
        return () => {
          try {
            proxy.off?.("PropertiesChanged", listener)
          } catch {
            // ignore
          }
        }
      },
      gattResolveTimeoutMs,
      "timed out waiting for GATT services to resolve",
    )

    const children = await helper.children()
    for (const servicePath of children) {
      const service = new GattService(this.dbus, this.adapter, this.device, servicePath)
      const uuid = await service.getUUID()
      await service.init()
      this._services[uuid] = service
    }
  }
}

interface GattServerLike {
  _services: Record<string, unknown>
  dbus: unknown
  adapter: string
  device: string
  helper: {
    iface: string
    prop: (name: string) => Promise<unknown>
    children: () => Promise<string[]>
    _propsProxy?: {
      on: (event: string, listener: (iface: string, changed: Record<string, { value?: unknown }>) => void) => void
      off?: (event: string, listener: (iface: string, changed: Record<string, { value?: unknown }>) => void) => void
    }
  }
}

/**
 * ensure le discovery is running.
 * bluez discovery is owned by the dbus client that started it. try stop (only
 * works if we own the session), then start; on "already in progress" piggyback.
 * if start still fails, power-cycle the adapter to clear a stuck session.
 * returns whether this call started discovery (caller should stop only if true).
 */
export async function ensureDiscovery(adapter: NodeBleAdapter): Promise<boolean> {
  try {
    if (await adapter.isDiscovering()) {
      try {
        await adapter.stopDiscovery()
        await sleep(150)
      } catch {
        // another client owns the session — piggyback below
      }
    }
  } catch {
    // ignore property read errors
  }

  if (await adapter.isDiscovering().catch(() => false)) {
    return false
  }

  try {
    await adapter.startDiscovery()
    return true
  } catch (err) {
    // BlueZ reports this as org.bluez.Error.InProgress ("InProgress") or
    // "Operation already in progress". Power-cycling here drops every other
    // connection on the adapter, including a peer plugin's session.
    if (isDiscoveryBusyError(err)) {
      return false
    }
    try {
      const msg = String((err as Error)?.message || err)
      process.stderr.write(
        `[govee-ble] power-cycling bluetooth adapter after discovery error: ${msg}\n`,
      )
      await powerCycleAdapter(adapter)
      await adapter.startDiscovery()
      return true
    } catch {
      throw err
    }
  }
}

/** true when startDiscovery failed because a discovery session already exists */
export function isDiscoveryBusyError(error: unknown): boolean {
  const typed = error as { message?: string, type?: string }
  const text = `${typed?.type || ""} ${typed?.message || error}`
  return /already in progress|inprogress/i.test(text)
}

/** power-cycle adapter via node-ble BusHelper (clears stuck Discovering) */
async function powerCycleAdapter(adapter: NodeBleAdapter): Promise<void> {
  const anyAdapter = adapter as unknown as {
    helper?: { set: (prop: string, value: unknown) => Promise<void> }
  }
  if (!anyAdapter.helper?.set) {
    return
  }
  // dbus-next Variant — same shape node-ble buildTypedValue uses
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Variant } = require("dbus-next") as {
    Variant: new (sig: string, value: unknown) => unknown
  }
  await anyAdapter.helper.set("Powered", new Variant("b", false))
  await sleep(300)
  await anyAdapter.helper.set("Powered", new Variant("b", true))
  await sleep(400)
}

export async function stopDiscoveryIfStarted(
  adapter: NodeBleAdapter,
  startedHere: boolean,
): Promise<void> {
  if (!startedHere) {
    return
  }
  try {
    if (await adapter.isDiscovering()) {
      await adapter.stopDiscovery()
    }
  } catch {
    // ignore
  }
}

/** discover every characteristic under every primary service */
export async function mapAllCharacteristics(
  device: NodeBleDevice,
): Promise<Map<string, { uuid: string, char: NodeBleGattCharacteristic }>> {
  const gatt = await device.gatt()
  const services = await gatt.services()
  const byUuid = new Map<string, { uuid: string, char: NodeBleGattCharacteristic }>()
  for (const serviceUuid of services) {
    try {
      const service = await gatt.getPrimaryService(serviceUuid)
      const chars = await service.characteristics()
      for (const charUuid of chars) {
        try {
          const char = await service.getCharacteristic(charUuid)
          byUuid.set(uuidKey(charUuid), { uuid: charUuid, char })
        } catch {
          // skip unreadable chars
        }
      }
    } catch {
      // skip services that fail to open
    }
  }
  return byUuid
}

export function uuidKey(uuid: string): string {
  const compact = uuid.replace(/-/g, "").toLowerCase()
  if (compact.length === 4) {
    return `0000${compact}00001000800000805f9b34fb`
  }
  if (compact.length === 8) {
    return `${compact}00001000800000805f9b34fb`
  }
  return compact
}
