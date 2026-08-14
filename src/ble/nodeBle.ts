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

function hardenDevice(device: NodeBleDevice): NodeBleDevice {
  const anyDevice = device as NodeBleDevice & {
    __hardened?: boolean
    helper?: { removeListeners?: () => void }
  }
  if (anyDevice.__hardened) {
    return device
  }
  anyDevice.__hardened = true

  const origConnect = device.connect.bind(device)
  const origDisconnect = device.disconnect.bind(device)
  device.connect = async () => {
    if (await isDeviceConnected(device)) {
      return
    }
    await origConnect()
  }
  device.disconnect = async () => {
    try {
      await origDisconnect()
    } finally {
      try {
        anyDevice.helper?.removeListeners?.()
      } catch {
        // ignore
      }
    }
  }

  const origGatt = device.gatt.bind(device)
  let gattCached: NodeBleGattServer | undefined
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
    const msg = String((err as Error)?.message || err)
    if (/already in progress/i.test(msg)) {
      return false
    }
    try {
      await powerCycleAdapter(adapter)
      await adapter.startDiscovery()
      return true
    } catch {
      throw err
    }
  }
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
