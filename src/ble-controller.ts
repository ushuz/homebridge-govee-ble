import type { Logger } from "homebridge"
import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble"

import { GOVEE_SERVICE_UUID, GOVEE_WRITE_UUID } from "./settings"

interface BleControllerOptions {
  scanTimeout: number
  connectTimeout: number
  commandRetries: number
}

interface DiscoveredGoveeDevice {
  name: string
  address: string
  rssi: number
}

const DISCONNECT_TIMEOUT = 2000
const CONNECTION_SETTLE_DELAY = 300
const RETRY_DELAY = 500

export class BleController {
  private readonly noble: Noble
  private readonly peripherals = new Map<string, Peripheral>()
  private readonly characteristics = new WeakMap<Peripheral, Characteristic>()
  private readonly watchedPeripherals = new WeakSet<Peripheral>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly options: BleControllerOptions,
    nobleClient?: Noble,
  ) {
    this.noble = nobleClient ?? require("@stoprocent/noble") as Noble
    this.noble.on("stateChange", state => {
      if (state !== "poweredOn") {
        this.peripherals.clear()
      }
    })
  }

  send(address: string, frame: Buffer): Promise<void> {
    const normalizedAddress = normalizeAddress(address)
    return this.enqueue(() => this.sendWithRetries(normalizedAddress, frame))
  }

  discoverGoveeDevices(): Promise<void> {
    return this.enqueue(() => this.scanForGoveeDevices())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.queue.then(operation)
    this.queue = queued.catch(() => undefined)
    return queued
  }

  private async scanForGoveeDevices(): Promise<void> {
    await this.waitForPoweredOn()

    const devices = new Map<string, DiscoveredGoveeDevice>()
    const onDiscover = (peripheral: Peripheral) => {
      const name = peripheral.advertisement.localName ?? ""
      if (!/^govee_h61e0(?:_|$)/i.test(name)) {
        return
      }

      const address = peripheral.address || peripheral.id
      const normalizedAddress = normalizeAddress(address)
      this.rememberPeripheral(normalizedAddress, peripheral)
      devices.set(normalizedAddress, {
        name,
        address,
        rssi: peripheral.rssi,
      })
    }

    const durationSeconds = this.options.scanTimeout / 1000
    this.log.info("Scanning for Govee H61E0 devices (%ss)...", durationSeconds)
    this.noble.on("discover", onDiscover)
    try {
      await this.noble.startScanningAsync([], true)
      await delay(this.options.scanTimeout)
    } finally {
      this.noble.removeListener("discover", onDiscover)
      await this.stopScanning()
    }

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
        await this.resetPeripheral(this.peripherals.get(address))
        if (attempt < this.options.commandRetries) {
          this.log.debug("BLE command to %s failed, retrying: %s", address, errorMessage(error))
          await delay(RETRY_DELAY)
        }
      }
    }

    throw lastError
  }

  private async sendOnce(address: string, frame: Buffer): Promise<void> {
    await this.waitForPoweredOn()

    const peripheral = await this.findPeripheral(address)
    await this.ensureConnected(peripheral, address)

    let characteristic = this.characteristics.get(peripheral)
    if (!characteristic) {
      characteristic = await this.findWriteCharacteristic(peripheral)
      this.characteristics.set(peripheral, characteristic)
    }

    this.log.debug("sending BLE frame to %s: %s", address, frame.toString("hex"))
    await withTimeout(characteristic.writeAsync(frame, true), 5000, `timed out writing to ${address}`)
    await delay(100)
  }

  private async waitForPoweredOn(): Promise<void> {
    if (this.noble.state === "poweredOn") {
      return
    }

    try {
      await this.noble.waitForPoweredOnAsync(5000)
    } catch {
      throw new Error(`Bluetooth adapter did not power on, current state is ${this.noble.state}`)
    }
  }

  private async findPeripheral(address: string): Promise<Peripheral> {
    const cached = this.peripherals.get(address)
    if (cached) {
      return cached
    }

    let onDiscover: ((candidate: Peripheral) => void) | undefined
    const peripheralPromise = new Promise<Peripheral>((resolve) => {
      onDiscover = (candidate: Peripheral) => {
        this.log.debug(
          "discovered BLE device %s (%s)",
          candidate.address,
          candidate.advertisement.localName ?? "unnamed",
        )
        if (normalizeAddress(candidate.address || candidate.id) === address) {
          this.noble.removeListener("discover", onDiscover!)
          this.rememberPeripheral(address, candidate)
          resolve(candidate)
        }
      }
      this.noble.on("discover", onDiscover)
    })

    try {
      await this.noble.startScanningAsync([], false)
      return await withTimeout(
        peripheralPromise,
        this.options.scanTimeout,
        `could not find Govee strip ${address}`,
      )
    } finally {
      if (onDiscover) {
        this.noble.removeListener("discover", onDiscover)
      }
      await this.stopScanning()
    }
  }

  private async findWriteCharacteristic(peripheral: Peripheral): Promise<Characteristic> {
    const services = await withTimeout(
      peripheral.discoverServicesAsync([]),
      this.options.connectTimeout,
      `timed out discovering Govee services on ${peripheral.address}`,
    )
    const service = services.find(candidate => normalizeUuid(candidate.uuid) === GOVEE_SERVICE_UUID)
    if (!service) {
      const discoveredUuids = services.map(candidate => candidate.uuid).join(", ") || "none"
      throw new Error(`Govee service not found on ${peripheral.address}; discovered ${discoveredUuids}`)
    }

    const characteristics = await withTimeout(
      service.discoverCharacteristicsAsync([GOVEE_WRITE_UUID]),
      this.options.connectTimeout,
      `timed out discovering Govee control characteristic on ${peripheral.address}`,
    )
    const characteristic = characteristics.find(candidate => normalizeUuid(candidate.uuid) === GOVEE_WRITE_UUID)
    if (!characteristic) {
      throw new Error(`Govee control characteristic not found on ${peripheral.address}`)
    }
    return characteristic
  }

  private async stopScanning(): Promise<void> {
    await this.noble.stopScanningAsync().catch(() => undefined)
  }

  private rememberPeripheral(address: string, peripheral: Peripheral): void {
    this.peripherals.set(address, peripheral)
    if (this.watchedPeripherals.has(peripheral)) {
      return
    }

    this.watchedPeripherals.add(peripheral)
    peripheral.on("disconnect", reason => {
      this.characteristics.delete(peripheral)
      this.log.debug("BLE peripheral %s disconnected: %s", address, reason)
    })
  }

  private async ensureConnected(peripheral: Peripheral, address: string): Promise<void> {
    const current = (): string => peripheral.state

    if (current() === "connecting" || current() === "disconnecting") {
      await this.waitForConnectionTransition(peripheral)
    }
    if (current() === "connected") {
      return
    }

    await withTimeout(
      peripheral.connectAsync(),
      this.options.connectTimeout,
      `timed out connecting to ${address}`,
    )
    await delay(CONNECTION_SETTLE_DELAY)
    if (current() !== "connected") {
      throw new Error(`Govee strip ${address} disconnected while establishing the BLE session`)
    }
  }

  private async resetPeripheral(peripheral?: Peripheral): Promise<void> {
    if (!peripheral) {
      return
    }

    this.characteristics.delete(peripheral)
    if (peripheral.state === "connecting") {
      peripheral.cancelConnect()
      if (peripheral.state === "connecting") {
        await this.waitForConnectionTransition(peripheral).catch(error => {
          this.log.debug("BLE connection reset failed: %s", errorMessage(error))
        })
      }
      return
    }
    if (peripheral.state === "disconnecting") {
      await this.waitForConnectionTransition(peripheral).catch(error => {
        this.log.debug("BLE connection reset failed: %s", errorMessage(error))
      })
      return
    }
    if (peripheral.state !== "connected") {
      return
    }

    await withTimeout(
      peripheral.disconnectAsync(),
      DISCONNECT_TIMEOUT,
      `timed out disconnecting from ${peripheral.address}`,
    ).catch(error => this.log.debug("BLE connection reset failed: %s", errorMessage(error)))
  }

  private async waitForConnectionTransition(peripheral: Peripheral): Promise<void> {
    let onTransition: (() => void) | undefined
    const transition = new Promise<void>((resolve) => {
      onTransition = resolve
      peripheral.once("connect", onTransition)
      peripheral.once("disconnect", onTransition)
    })

    try {
      await withTimeout(
        transition,
        DISCONNECT_TIMEOUT,
        `timed out waiting for BLE connection state ${peripheral.state} on ${peripheral.address}`,
      )
    } finally {
      peripheral.removeListener("connect", onTransition!)
      peripheral.removeListener("disconnect", onTransition!)
    }
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

function normalizeUuid(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase()
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
