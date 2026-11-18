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
  /** true after dbus refuses further match rules on this connection */
  isPoisoned?(): boolean
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
  prototype: {
    children: () => Promise<string[]>
    _prepare: () => Promise<void>
    removeListeners: () => void
  }
  buildChildren: (path: string, nodes: string[]) => string[]
}

let busHelperPatched = false

/** open dbus connection and bind the configured hciN adapter (no silent fallback) */
export async function openBleBus(hciDeviceId = 0): Promise<BleBus> {
  const { bluetooth, destroy } = nodeBle.createBluetooth()
  installNodeBlePatches()
  // node-ble does not handle dbus 'error'; unhandled emitters crash the process.
  // destroying here would drop the in-flight adapter lock, so the next command
  // reopens the bus once match rules are exhausted.
  let poisoned = false
  const dbus = (bluetooth as { dbus?: { on?: (event: string, cb: (err: Error) => void) => void } }).dbus
  if (dbus?.on) {
    dbus.on("error", (err: Error) => {
      const message = err?.message || String(err)
      process.stderr.write(`[node-ble] dbus error: ${message}\n`)
      if (/match rules/i.test(message)) {
        poisoned = true
      }
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
    patchAdapterDeviceCache(adapter)
    return {
      adapter,
      adapterName: preferred,
      destroy,
      isPoisoned: () => poisoned,
    }
  } catch (err) {
    try {
      destroy()
    } catch {
      // ignore
    }
    throw err
  }
}

/** apply the node-ble / dbus-next patches once. safe to call from tests. */
export function installNodeBlePatches(): void {
  patchDbusMatchRefcount()
  patchBusHelperChildren()
  patchGattServerInit()
}

/**
 * node-ble BusHelper.children() rebuilds a dbus-next ProxyObject every call.
 * each new proxy adds AddMatch rules until dbus hits max_match_rules (2048).
 * reuse the existing proxy and refresh the child list via introspect.
 */
/**
 * dbus-next 0.10 checks `hasOwnProperty` with the rule and the map swapped,
 * so every _addMatch sends AddMatch and _removeMatch never sends RemoveMatch.
 * BlueZ counts each AddMatch toward max_match_rules_per_connection.
 */
function patchDbusMatchRefcount(): void {
  if (matchRulesPatched) {
    return
  }
  matchRulesPatched = true
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MessageBus = require("dbus-next/lib/bus") as {
    prototype: {
      _addMatch: (this: MatchBus, match: string) => Promise<unknown>
      _removeMatch: (this: MatchBus, match: string) => Promise<unknown>
    }
  }
  const origAdd = MessageBus.prototype._addMatch
  MessageBus.prototype._addMatch = function addMatchRefcounted(this: MatchBus, match: string) {
    if (Object.prototype.hasOwnProperty.call(this._matchRules, match)) {
      this._matchRules[match] += 1
      return Promise.resolve()
    }
    return origAdd.call(this, match)
  }
  MessageBus.prototype._removeMatch = function removeMatchRefcounted(this: MatchBus, match: string) {
    if (!this._connection?.stream?.writable) {
      return Promise.resolve()
    }
    if (!Object.prototype.hasOwnProperty.call(this._matchRules, match)) {
      return Promise.resolve()
    }
    this._matchRules[match] -= 1
    if (this._matchRules[match] > 0) {
      return Promise.resolve()
    }
    delete this._matchRules[match]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Message } = require("dbus-next/lib/message-type") as {
      Message: new (options: Record<string, unknown>) => unknown
    }
    return this.call(new Message({
      path: "/org/freedesktop/DBus",
      destination: "org.freedesktop.DBus",
      interface: "org.freedesktop.DBus",
      member: "RemoveMatch",
      signature: "s",
      body: [match],
    }))
  }
}

interface MatchBus {
  _matchRules: Record<string, number>
  _connection?: { stream?: { writable?: boolean } }
  call: (message: unknown) => Promise<unknown>
}

let matchRulesPatched = false

function patchBusHelperChildren(): void {
  if (busHelperPatched) {
    return
  }
  BusHelper.prototype.removeListeners = function removeListenersKeepProxy(this: {
    removeAllListeners: (event?: string) => void
  }): void {
    // keep the Properties proxy. dropping it (_ready = false) makes the next
    // call build a new proxy, which AddMatch'es again.
    this.removeAllListeners("PropertiesChanged")
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

interface DeviceCache {
  __deviceCache?: Map<string, NodeBleDevice>
}

function deviceCache(adapter: NodeBleAdapter): Map<string, NodeBleDevice> | undefined {
  return (adapter as NodeBleAdapter & DeviceCache).__deviceCache
}

export function forgetCachedDevice(adapter: NodeBleAdapter, address: string): void {
  const cache = deviceCache(adapter)
  if (!cache) {
    return
  }
  const formatted = formatBleAddress(address)
  const device = cache.get(formatted)
  if (!device) {
    return
  }
  cache.delete(formatted)
  releaseDevice(device)
}

/** drop every cached device except `keep` (uppercase addresses) and release its match rules */
export function releaseCachedDevicesExcept(
  adapter: NodeBleAdapter,
  keep: ReadonlySet<string>,
): void {
  const cache = deviceCache(adapter)
  if (!cache) {
    return
  }
  for (const [address, device] of [...cache.entries()]) {
    if (keep.has(address)) {
      continue
    }
    cache.delete(address)
    releaseDevice(device)
  }
}

/**
 * drop dbus listeners for a device and its GATT tree.
 * idempotent. call when the handle will not be used again.
 */
export function releaseDevice(device: NodeBleDevice | undefined): void {
  if (!device) {
    return
  }
  const anyDevice = device as NodeBleDevice & {
    __released?: boolean
    __gattServer?: unknown
    helper?: unknown
    removeAllListeners?: () => void
  }
  if (anyDevice.__released) {
    return
  }
  anyDevice.__released = true
  releaseGattTree(anyDevice.__gattServer)
  anyDevice.__gattServer = undefined
  try {
    anyDevice.removeAllListeners?.()
  } catch {
    // ignore
  }
  releaseBusHelper(anyDevice.helper)
}

function releaseGattTree(gatt: unknown): void {
  if (!gatt || typeof gatt !== "object") {
    return
  }
  const server = gatt as {
    helper?: unknown
    _services?: Record<string, {
      helper?: unknown
      _characteristics?: Record<string, { helper?: unknown, removeAllListeners?: () => void }>
    }>
  }
  for (const service of Object.values(server._services ?? {})) {
    for (const characteristic of Object.values(service._characteristics ?? {})) {
      try {
        characteristic.removeAllListeners?.()
      } catch {
        // ignore
      }
      releaseBusHelper(characteristic.helper)
    }
    releaseBusHelper(service.helper)
  }
  releaseBusHelper(server.helper)
}

function releaseBusHelper(helper: unknown): void {
  if (!helper || typeof helper !== "object") {
    return
  }
  const bus = helper as {
    _ready?: boolean
    _released?: boolean
    _propsProxy?: { removeAllListeners?: (event?: string) => void } | null
    _ifaceProxy?: { removeAllListeners?: () => void } | null
    _objectProxy?: unknown
    removeAllListeners?: (event?: string) => void
  }
  if (bus._released) {
    return
  }
  bus._released = true
  try {
    bus.removeAllListeners?.("PropertiesChanged")
  } catch {
    // ignore
  }
  try {
    bus._propsProxy?.removeAllListeners?.("PropertiesChanged")
  } catch {
    // ignore
  }
  try {
    bus._ifaceProxy?.removeAllListeners?.()
  } catch {
    // ignore
  }
  bus._propsProxy = null
  bus._ifaceProxy = null
  bus._objectProxy = null
  bus._ready = false
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
    __gattServer?: unknown
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
    const previous = gattCached
    gattCached = undefined
    anyDevice.__gattServer = undefined
    releaseGattTree(previous)
  }
  device.connect = async () => {
    const connected = await isDeviceConnected(device)
    if (!connected) {
      dropGatt()
      clearHelperUserListeners(anyDevice)
      anyDevice.__watchInstalled = false
      try {
        await origConnect()
      } catch (err) {
        // node-ble connect() arms PropertiesChanged before Connect returns.
        // a failed attempt must not leave that listener in place.
        clearHelperUserListeners(anyDevice)
        throw err
      }
      return
    }
    installConnectedWatch(anyDevice, dropGatt)
  }
  device.disconnect = async () => {
    try {
      await origDisconnect()
    } finally {
      dropGatt()
      anyDevice.__watchInstalled = false
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
        // stale server; fall through and rebuild
      }
      dropGatt()
    }
    const next = await origGatt()
    gattCached = next
    anyDevice.__gattServer = next
    return next
  }

  return device
}

function clearHelperUserListeners(device: {
  helper?: { removeAllListeners?: (event: string) => void }
}): void {
  try {
    // user listeners live on the BusHelper. the proxy forwarder stays so the
    // match rule is not removed and added again on the next connect.
    device.helper?.removeAllListeners?.("PropertiesChanged")
  } catch {
    // ignore
  }
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
export function patchGattServerInit(timeoutMs?: number): void {
  if (timeoutMs !== undefined) {
    gattResolveTimeoutMs = timeoutMs
  }
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
 * bluez discovery is owned by the dbus sender that started it, not by the
 * Discovering property. node-ble refuses to StopDiscovery unless that
 * property is already true, so a session can stay registered (next
 * StartDiscovery returns InProgress) and, on BlueZ 5.66, leave Discovering
 * stuck with no Device1 objects.
 * returns whether this call owns a session the caller must stop.
 */
const DISCOVERY_RPC_TIMEOUT_MS = 8_000

export async function ensureDiscovery(
  adapter: NodeBleAdapter,
  rpcTimeoutMs = DISCOVERY_RPC_TIMEOUT_MS,
): Promise<boolean> {
  if (isDiscoveryOwned(adapter)) {
    await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
  }

  if (await readDiscovering(adapter)) {
    const stopped = await tryStopDiscovery(adapter, rpcTimeoutMs)
    if (stopped === "absent") {
      // this connection has no session. an empty device list with the flag
      // stuck on is the BlueZ 5.66 wedge (kernel scan dead, no client left).
      // another client's scan that has already found devices is left alone.
      if (!(await adapterHasNoDevices(adapter))) {
        return false
      }
      process.stderr.write(
        "[govee-ble] bluetooth discovery is on but no devices are present; power-cycling adapter\n",
      )
      await powerCycleAdapter(adapter)
    } else if (stopped !== "stopped") {
      await stopOwnedDiscovery(adapter, rpcTimeoutMs, isDiscoveryOwned(adapter))
      if (await readDiscovering(adapter)) {
        return false
      }
    } else {
      // the method reply can land before the Discovering property flips
      await sleep(150)
      if (await readDiscovering(adapter)) {
        return false
      }
    }
  }

  return startDiscoveryOwned(adapter, rpcTimeoutMs)
}

async function startDiscoveryOwned(
  adapter: NodeBleAdapter,
  rpcTimeoutMs: number,
): Promise<boolean> {
  markDiscoveryOwned(adapter, true)
  try {
    await startDiscoverySession(adapter, rpcTimeoutMs)
    return true
  } catch (err) {
    // InProgress means THIS sender already has a discovery client. that is
    // our leaked session, not a peer. stop it and start once more. do not
    // power-cycle: a peer plugin may be connected on the same adapter.
    if (isDiscoveryBusyError(err)) {
      const stopped = await tryStopDiscovery(adapter, rpcTimeoutMs)
      if (stopped === "busy" || stopped === "failed") {
        await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
      }
      try {
        markDiscoveryOwned(adapter, true)
        await startDiscoverySession(adapter, rpcTimeoutMs)
        return true
      } catch (retryErr) {
        if (isDiscoveryBusyError(retryErr)) {
          markDiscoveryOwned(adapter, true)
          return true
        }
        await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
        throw retryErr
      }
    }

    try {
      await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
      process.stderr.write(
        `[govee-ble] power-cycling bluetooth adapter after discovery error: ${errorText(err)}\n`,
      )
      await powerCycleAdapter(adapter)
      markDiscoveryOwned(adapter, true)
      await startDiscoverySession(adapter, rpcTimeoutMs)
      return true
    } catch {
      await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
      throw err
    }
  }
}

/** true when startDiscovery failed because a discovery session already exists */
export function isDiscoveryBusyError(error: unknown): boolean {
  return /already in progress|inprogress/i.test(errorText(error))
}

function errorText(error: unknown): string {
  const typed = error as { message?: string, type?: string }
  return `${typed?.type || ""} ${typed?.message || error}`
}

type StopResult = "stopped" | "absent" | "busy" | "failed"

/**
 * stop a discovery session this connection owns.
 * bypasses node-ble's Discovering guard, which skips the BlueZ call when the
 * property has not flipped yet and therefore leaks the client.
 */
async function tryStopDiscovery(
  adapter: NodeBleAdapter,
  rpcTimeoutMs: number,
): Promise<StopResult> {
  try {
    await withTimeout(
      callAdapterMethod(adapter, "StopDiscovery"),
      rpcTimeoutMs,
      "timed out stopping discovery",
    )
    return "stopped"
  } catch (err) {
    if (/no discovery started/i.test(errorText(err))) {
      return "absent"
    }
    if (isDiscoveryBusyError(err)) {
      return "busy"
    }
    return "failed"
  }
}

async function stopOwnedDiscovery(
  adapter: NodeBleAdapter,
  rpcTimeoutMs: number,
  powerCycle: boolean,
): Promise<void> {
  const ownedAtStart = isDiscoveryOwned(adapter)
  let sawBusy = false
  let last: StopResult = "failed"
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await tryStopDiscovery(adapter, rpcTimeoutMs)
    if (last === "busy") {
      sawBusy = true
    }
    if (last === "stopped") {
      markDiscoveryOwned(adapter, false)
      return
    }
    if (last === "absent") {
      markDiscoveryOwned(adapter, false)
      // BlueZ 5.66 can remove the client and still leave Discovering true
      // when the kernel rejects the stop. that only happens for the last
      // client, and the dbus reply is InProgress before the client is gone.
      if (powerCycle && ownedAtStart && sawBusy && await readDiscovering(adapter)) {
        process.stderr.write(
          "[govee-ble] power-cycling bluetooth adapter to clear stuck discovery\n",
        )
        await powerCycleAdapter(adapter)
      }
      return
    }
    if (last === "failed") {
      break
    }
    await sleep(200)
  }
  markDiscoveryOwned(adapter, false)
  if (powerCycle && ownedAtStart && await readDiscovering(adapter)) {
    process.stderr.write(
      "[govee-ble] power-cycling bluetooth adapter to clear stuck discovery\n",
    )
    await powerCycleAdapter(adapter)
  }
}

async function startDiscoverySession(
  adapter: NodeBleAdapter,
  rpcTimeoutMs: number,
): Promise<void> {
  await withTimeout((async () => {
    const helper = adapterHelper(adapter)
    if (helper?.callMethod) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const buildTypedValue = require("node-ble/src/buildTypedValue") as (
          type: string,
          value: string,
        ) => unknown
        await helper.callMethod("SetDiscoveryFilter", {
          Transport: buildTypedValue("string", "le"),
        })
      } catch (err) {
        process.stderr.write(
          `[govee-ble] discovery filter failed: ${errorText(err)}\n`,
        )
      }
      await helper.callMethod("StartDiscovery")
      return
    }
    await adapter.startDiscovery()
  })(), rpcTimeoutMs, "timed out starting discovery")
}

async function callAdapterMethod(adapter: NodeBleAdapter, method: "StopDiscovery"): Promise<void> {
  const helper = adapterHelper(adapter)
  if (helper?.callMethod) {
    await helper.callMethod(method)
    return
  }
  await adapter.stopDiscovery()
}

interface AdapterHelper {
  callMethod?: (method: string, ...args: unknown[]) => Promise<unknown>
  set?: (prop: string, value: unknown) => Promise<void>
}

function adapterHelper(adapter: NodeBleAdapter): AdapterHelper | undefined {
  return (adapter as NodeBleAdapter & { helper?: AdapterHelper }).helper
}

function isDiscoveryOwned(adapter: NodeBleAdapter): boolean {
  return (adapter as NodeBleAdapter & { __discoveryOwned?: boolean }).__discoveryOwned === true
}

function markDiscoveryOwned(adapter: NodeBleAdapter, owned: boolean): void {
  (adapter as NodeBleAdapter & { __discoveryOwned?: boolean }).__discoveryOwned = owned
}

async function readDiscovering(adapter: NodeBleAdapter): Promise<boolean> {
  try {
    return await adapter.isDiscovering()
  } catch {
    return false
  }
}

async function adapterHasNoDevices(adapter: NodeBleAdapter): Promise<boolean> {
  try {
    const listed = await adapter.devices()
    return listed.length === 0
  } catch {
    return false
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const guarded = promise.then(
    (value) => {
      if (timedOut) {
        return undefined as T
      }
      return value
    },
    (error: unknown) => {
      if (timedOut) {
        return undefined as T
      }
      throw error
    },
  )
  try {
    return await Promise.race([
      guarded,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(message))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** power-cycle adapter via node-ble BusHelper (clears stuck Discovering) */
async function powerCycleAdapter(adapter: NodeBleAdapter): Promise<void> {
  const helper = adapterHelper(adapter)
  if (!helper?.set) {
    return
  }
  // dbus-next Variant — same shape node-ble buildTypedValue uses
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Variant } = require("dbus-next") as {
    Variant: new (sig: string, value: unknown) => unknown
  }
  await helper.set("Powered", new Variant("b", false))
  await sleep(300)
  await helper.set("Powered", new Variant("b", true))
  await sleep(400)
}

export async function stopDiscoveryIfStarted(
  adapter: NodeBleAdapter,
  startedHere: boolean,
  rpcTimeoutMs = DISCOVERY_RPC_TIMEOUT_MS,
): Promise<void> {
  if (!startedHere && !isDiscoveryOwned(adapter)) {
    return
  }
  try {
    await stopOwnedDiscovery(adapter, rpcTimeoutMs, true)
  } catch (err) {
    process.stderr.write(`[govee-ble] stop discovery failed: ${errorText(err)}\n`)
  }
}

/**
 * stop discovery before a connect. a session this process started is stopped
 * even when the Discovering property has not flipped yet. another client's
 * scan is left running.
 */
export async function stopDiscoveryBeforeConnect(adapter: NodeBleAdapter): Promise<void> {
  if (!isDiscoveryOwned(adapter) && !(await readDiscovering(adapter))) {
    return
  }
  await stopDiscoveryIfStarted(adapter, true)
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
