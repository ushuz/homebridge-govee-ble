import type { Logger } from "homebridge"

import { withBleAdapterLock } from "./ble/adapterLock"
import {
  ensureDiscovery,
  forgetCachedDevice,
  formatBleAddress,
  isMissingBluezInterface,
  normalizeBleAddress,
  openBleBus,
  stopDiscoveryIfStarted,
  uuidKey,
  type BleBus,
  type BleBusFactory,
  type NodeBleDevice,
  type NodeBleGattCharacteristic,
} from "./ble/nodeBle"
import { createStatusFrame, parseStatusPacket } from "./protocol"
import { GOVEE_NOTIFY_UUID, GOVEE_SERVICE_UUID, GOVEE_WRITE_UUID } from "./settings"

interface BleControllerOptions {
  scanTimeout: number
  connectTimeout: number
  commandRetries: number
  /** bluez adapter index (hci0 = 0); shared lock is per-adapter */
  hciDeviceId?: number
}

const LOCK_OWNER = "govee-ble"

interface DiscoveredGoveeDevice {
  name: string
  address: string
  rssi: number
}

const DISCONNECT_TIMEOUT = 2000
const CONNECTION_SETTLE_DELAY = 300
const RETRY_DELAY = 500

export class BleController {
  private bus: BleBus | undefined
  private readonly openBus: BleBusFactory
  private readonly devices = new Map<string, NodeBleDevice>()
  private readonly writeChars = new WeakMap<NodeBleDevice, NodeBleGattCharacteristic>()
  private readonly notifyChars = new WeakMap<NodeBleDevice, NodeBleGattCharacteristic>()
  private readonly watched = new WeakSet<NodeBleDevice>()
  /** node-ble connect() already run for this device (listeners installed) */
  private readonly sessionReady = new WeakSet<NodeBleDevice>()

  constructor(
    private readonly log: Logger,
    private readonly options: BleControllerOptions,
    openBus: BleBusFactory = openBleBus,
  ) {
    this.openBus = openBus
  }

  send(address: string, frame: Buffer): Promise<void> {
    const normalizedAddress = normalizeBleAddress(address)
    return this.enqueue(() => this.sendWithRetries(normalizedAddress, frame))
  }

  /** read power state from the strip (0xaa query / notify reply) */
  readPowerState(address: string): Promise<boolean | null> {
    const normalizedAddress = normalizeBleAddress(address)
    return this.enqueue(() => this.readPowerStateOnce(normalizedAddress))
  }

  discoverGoveeDevices(): Promise<void> {
    return this.enqueue(() => this.scanForGoveeDevices())
  }

  /** disconnect retained sessions and close the dbus bus (homebridge shutdown) */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      for (const [address, device] of [...this.devices.entries()]) {
        this.writeChars.delete(device)
        this.devices.delete(address)
        try {
          await device.disconnect()
        } catch {
          // ignore
        }
      }
      if (this.bus) {
        try {
          if (await this.bus.adapter.isDiscovering()) {
            await this.bus.adapter.stopDiscovery()
          }
        } catch {
          // ignore
        }
        try {
          this.bus.destroy()
        } catch {
          // ignore
        }
        this.bus = undefined
      }
    }).catch((error) => {
      this.log.debug("ble stop failed: %s", errorMessage(error))
    })
  }

  /**
   * serialize on the shared in-process ble queue (and file lock for other
   * processes). plugin-local this.queue is no longer the radio mutex.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.withAdapterLock(operation)
  }

  private withAdapterLock<T>(operation: () => Promise<T>): Promise<T> {
    // peer airthings scans are short; dbus property walks happen outside the lock.
    // keep headroom for pi zero contention.
    const acquireTimeoutMs = Math.max(
      180_000,
      this.options.scanTimeout + this.options.connectTimeout + 90_000,
    )
    return withBleAdapterLock(
      {
        owner: LOCK_OWNER,
        hciDeviceId: this.options.hciDeviceId ?? 0,
        acquireTimeoutMs,
        log: {
          debug: (message, ...args) => this.log.debug(message, ...args),
          info: (message, ...args) => this.log.info(message, ...args),
          warn: (message, ...args) => this.log.warn(message, ...args),
        },
      },
      operation,
    )
  }

  private async ensureBus(): Promise<BleBus> {
    if (!this.bus) {
      this.bus = await this.openBus(this.options.hciDeviceId ?? 0)
      this.log.debug(
        "bluetooth adapter ready (%s) via node-ble/bluez",
        this.bus.adapterName,
      )
    }
    return this.bus
  }

  private async scanForGoveeDevices(): Promise<void> {
    const { adapter } = await this.ensureBus()
    const devices = new Map<string, DiscoveredGoveeDevice>()
    const durationSeconds = this.options.scanTimeout / 1000
    this.log.info("Scanning for Govee H61E0 devices (%ss)...", durationSeconds)

    // inspect while discovery is active — name/mfg props often vanish after stop
    await this.withAdapterLock(async () => {
      const startedHere = await ensureDiscovery(adapter)
      try {
        const deadline = Date.now() + this.options.scanTimeout
        while (Date.now() < deadline) {
          const addresses = await adapter.devices()
          await mapPool(addresses, 6, async (address) => {
            try {
              const device = await adapter.getDevice(address)
              const name = (await device.getName().catch(() => null))
                || (await device.getAlias().catch(() => null))
                || ""
              if (!/^govee_h61e0(?:_|$)/i.test(name)) {
                return
              }
              const normalized = normalizeBleAddress(address)
              this.rememberDevice(normalized, device)
              const rssiRaw = await device.getRSSI().catch(() => 0)
              devices.set(normalized, {
                name: name || "Govee_H61E0",
                address: normalized,
                rssi: Number(rssiRaw) || 0,
              })
            } catch {
              // device may disappear mid-scan
            }
          })
          if (devices.size > 0) {
            break
          }
          await delay(1000)
        }
      } finally {
        await stopDiscoveryIfStarted(adapter, startedHere)
      }
    })

    const discovered = [...devices.values()]
    this.log.info("Discovered %s Govee H61E0 device(s)", discovered.length)
    for (const device of discovered) {
      this.log.info("  - %s address=%s rssi=%s", device.name, device.address, device.rssi)
    }
  }

  private async sendWithRetries(address: string, frame: Buffer): Promise<void> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.options.commandRetries; attempt += 1) {
      try {
        await this.sendOnce(address, frame)
        return
      } catch (error) {
        lastError = error
        await this.resetDevice(this.devices.get(address))
        if (attempt < this.options.commandRetries) {
          this.log.debug("BLE command to %s failed, retrying: %s", address, errorMessage(error))
          await delay(RETRY_DELAY)
        }
      }
    }

    throw lastError
  }

  private async sendOnce(address: string, frame: Buffer): Promise<void> {
    let device: NodeBleDevice
    try {
      device = await this.findDevice(address)
      await this.ensureConnected(device, address)
    } catch (error) {
      if (isMissingBluezInterface(error)) {
        this.forgetDevice(address)
        device = await this.findDevice(address)
        await this.ensureConnected(device, address)
      } else {
        throw error
      }
    }

    let characteristic = this.writeChars.get(device)
    if (!characteristic) {
      characteristic = await this.findWriteCharacteristic(device)
      this.writeChars.set(device, characteristic)
    }

    this.log.debug("sending BLE frame to %s: %s", address, frame.toString("hex"))
    await withTimeout(
      characteristic.writeValueWithoutResponse(frame),
      5000,
      `timed out writing to ${address}`,
    )
    await delay(100)
  }

  private forgetDevice(address: string, device?: NodeBleDevice): void {
    if (device) {
      this.writeChars.delete(device)
      this.notifyChars.delete(device)
    }
    const cached = this.devices.get(address)
    if (cached) {
      this.writeChars.delete(cached)
      this.notifyChars.delete(cached)
      this.devices.delete(address)
    }
    if (this.bus) {
      forgetCachedDevice(this.bus.adapter, address)
    }
  }

  private async probeDevice(device: NodeBleDevice): Promise<void> {
    await device.getAddress()
  }

  private async findDevice(address: string): Promise<NodeBleDevice> {
    const { adapter } = await this.ensureBus()
    const formatted = formatBleAddress(address)

    const cached = this.devices.get(address)
    if (cached) {
      try {
        await this.probeDevice(cached)
        return cached
      } catch (error) {
        this.log.debug("dropping stale govee device %s: %s", address, errorMessage(error))
        this.forgetDevice(address, cached)
      }
    }

    try {
      const device = await adapter.getDevice(formatted)
      await this.probeDevice(device)
      this.rememberDevice(address, device)
      return device
    } catch {
      // fall through to discovery wait
    }

    // caller (enqueue/send) already holds the shared radio lock — do not
    // re-enter withAdapterLock or we wait on ourselves forever.
    const startedHere = await ensureDiscovery(adapter)
    try {
      const device = await withTimeout(
        adapter.waitDevice(formatted, this.options.scanTimeout, 250),
        this.options.scanTimeout + 1000,
        `could not find Govee strip ${address}`,
      )
      this.rememberDevice(address, device)
      return device
    } finally {
      await stopDiscoveryIfStarted(adapter, startedHere)
    }
  }

  private async readPowerStateOnce(address: string): Promise<boolean | null> {
    const device = await this.findDevice(address)
    await this.ensureConnected(device, address)
    const write = this.writeChars.get(device) ?? await this.findWriteCharacteristic(device)
    this.writeChars.set(device, write)
    const notify = this.notifyChars.get(device) ?? await this.findNotifyCharacteristic(device)
    this.notifyChars.set(device, notify)

    const packet = await this.queryNotify(write, notify, createStatusFrame())
    const parsed = packet ? parseStatusPacket(packet) : null
    return parsed ? parsed.on : null
  }

  private async queryNotify(
    write: NodeBleGattCharacteristic,
    notify: NodeBleGattCharacteristic,
    frame: Buffer,
  ): Promise<Buffer | null> {
    let settled: Buffer | null = null
    const onData = (buffer: Buffer) => {
      if (!settled) {
        settled = buffer
      }
    }
    notify.on("valuechanged", onData)
    try {
      await notify.startNotifications()
      await withTimeout(
        write.writeValueWithoutResponse(frame),
        5000,
        "timed out writing status query",
      )
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !settled) {
        await delay(50)
      }
      return settled
    } finally {
      notify.removeListener("valuechanged", onData)
      try {
        await notify.stopNotifications()
      } catch {
        // ignore
      }
    }
  }

  private async findWriteCharacteristic(device: NodeBleDevice): Promise<NodeBleGattCharacteristic> {
    const { write } = await this.findControlCharacteristics(device)
    return write
  }

  private async findNotifyCharacteristic(device: NodeBleDevice): Promise<NodeBleGattCharacteristic> {
    const cached = this.notifyChars.get(device)
    if (cached) {
      return cached
    }
    const { notify } = await this.findControlCharacteristics(device)
    if (!notify) {
      throw new Error("Govee notify characteristic not found")
    }
    this.notifyChars.set(device, notify)
    return notify
  }

  private async findControlCharacteristics(device: NodeBleDevice): Promise<{
    write: NodeBleGattCharacteristic
    notify: NodeBleGattCharacteristic | null
  }> {
    const gatt = await withTimeout(
      device.gatt(),
      this.options.connectTimeout,
      `timed out opening GATT on device`,
    )
    const services = await gatt.services()
    const serviceUuid = services.find((u) => uuidKey(u) === GOVEE_SERVICE_UUID)
    if (!serviceUuid) {
      throw new Error(
        `Govee service not found; discovered ${services.join(", ") || "none"}`,
      )
    }
    const service = await gatt.getPrimaryService(serviceUuid)
    const chars = await service.characteristics()
    const writeUuid = chars.find((u) => uuidKey(u) === GOVEE_WRITE_UUID)
    if (!writeUuid) {
      throw new Error("Govee control characteristic not found")
    }
    const notifyUuid = chars.find((u) => uuidKey(u) === GOVEE_NOTIFY_UUID)
    const write = await service.getCharacteristic(writeUuid)
    const notify = notifyUuid ? await service.getCharacteristic(notifyUuid) : null
    return { write, notify }
  }

  private rememberDevice(address: string, device: NodeBleDevice): void {
    this.devices.set(address, device)
    if (this.watched.has(device)) {
      return
    }
    this.watched.add(device)
    device.on("disconnect", () => {
      this.writeChars.delete(device)
      this.notifyChars.delete(device)
      // drop cache so the next command fetches a fresh Device and avoids
      // stacking node-ble PropertiesChanged listeners across reconnects
      if (this.devices.get(address) === device) {
        this.devices.delete(address)
      }
      this.log.debug("BLE device %s disconnected", address)
    })
  }

  private async ensureConnected(device: NodeBleDevice, address: string): Promise<void> {
    // bluez prefers discovery off before connect
    const { adapter } = await this.ensureBus()
    const wasDiscovering = await adapter.isDiscovering()
    if (wasDiscovering) {
      try { await adapter.stopDiscovery() } catch { /* ignore */ }
    }
    try {
      if (await isConnected(device)) {
        // leftover bluez session: call connect() once so node-ble installs
        // disconnect listeners; skip on later commands to avoid stacking them.
        if (!this.sessionReady.has(device)) {
          this.writeChars.delete(device)
          try {
            await withTimeout(
              device.connect(),
              this.options.connectTimeout,
              `timed out reconnecting to ${address}`,
            )
          } catch {
            // some bluez versions error when already connected — keep going
          }
          this.sessionReady.add(device)
        }
        return
      }

      try {
        await withTimeout(
          device.connect(),
          this.options.connectTimeout,
          `timed out connecting to ${address}`,
        )
      } catch (err) {
        // cancel in-progress bluez Connect so retries do not see InProgress
        try { await device.disconnect() } catch { /* ignore */ }
        throw err
      }
      await delay(CONNECTION_SETTLE_DELAY)
      if (!(await isConnected(device))) {
        throw new Error(`Govee strip ${address} disconnected while establishing the BLE session`)
      }
      this.sessionReady.add(device)
    } finally {
      if (wasDiscovering) {
        try {
          if (!(await adapter.isDiscovering())) {
            await adapter.startDiscovery()
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private async resetDevice(device?: NodeBleDevice): Promise<void> {
    if (!device) {
      return
    }
    let address: string | undefined
    for (const [addr, cached] of this.devices) {
      if (cached === device) {
        address = addr
        break
      }
    }
    if (address) {
      this.forgetDevice(address, device)
    } else {
      this.writeChars.delete(device)
      this.notifyChars.delete(device)
    }
    if (!(await isConnected(device))) {
      return
    }
    await withTimeout(
      device.disconnect(),
      DISCONNECT_TIMEOUT,
      "timed out disconnecting",
    ).catch(error => this.log.debug("BLE connection reset failed: %s", errorMessage(error)))
  }
}

async function isConnected(device: NodeBleDevice): Promise<boolean> {
  try {
    const v = await device.isConnected()
    return v === true || v === "true"
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeout)
  }
}

/** run async work over items with a concurrency limit */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return
  }
  const limit = Math.max(1, concurrency)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      await worker(items[i])
    }
  })
  await Promise.all(runners)
}

