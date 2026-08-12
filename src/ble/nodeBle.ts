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

/** open dbus connection and bind the configured hciN adapter (no silent fallback) */
export async function openBleBus(hciDeviceId = 0): Promise<BleBus> {
  const { bluetooth, destroy } = nodeBle.createBluetooth()
  // node-ble does not handle dbus 'error'; unhandled emitters crash the process
  const dbus = (bluetooth as { dbus?: { on?: (event: string, cb: (err: Error) => void) => void } }).dbus
  if (dbus?.on) {
    dbus.on("error", (err: Error) => {
      try {
        destroy()
      } catch {
        // ignore
      }
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

/**
 * start discovery if not already running (another client may own it).
 * returns whether this call started discovery (caller should stop only if true).
 */
export async function ensureDiscovery(adapter: NodeBleAdapter): Promise<boolean> {
  if (await adapter.isDiscovering()) {
    return false
  }
  await adapter.startDiscovery()
  return true
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
