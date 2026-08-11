import type { Logger } from "homebridge"
import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble"

import { GOVEE_SERVICE_UUID, GOVEE_WRITE_UUID } from "./settings"

interface BleControllerOptions {
  scanTimeout: number
  connectTimeout: number
  commandRetries: number
}

const DISCONNECT_TIMEOUT = 2000

export class BleController {
  private readonly noble: Noble
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly options: BleControllerOptions,
    nobleClient?: Noble,
  ) {
    this.noble = nobleClient ?? require("@stoprocent/noble") as Noble
  }

  send(address: string, frame: Buffer): Promise<void> {
    const normalizedAddress = normalizeAddress(address)
    const operation = this.queue.then(() => this.sendWithRetries(normalizedAddress, frame))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async sendWithRetries(address: string, frame: Buffer): Promise<void> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.options.commandRetries; attempt += 1) {
      try {
        await this.sendOnce(address, frame)
        return
      } catch (error) {
        lastError = error
        if (attempt < this.options.commandRetries) {
          this.log.debug("BLE command to %s failed, retrying: %s", address, errorMessage(error))
          await delay(250)
        }
      }
    }

    throw lastError
  }

  private async sendOnce(address: string, frame: Buffer): Promise<void> {
    await this.waitForPoweredOn()

    let peripheral: Peripheral | undefined
    try {
      peripheral = await this.findPeripheral(address)
      await withTimeout(
        peripheral.connectAsync(),
        this.options.connectTimeout,
        `timed out connecting to ${address}`,
      )

      const characteristic = await this.findWriteCharacteristic(peripheral)
      this.log.debug("sending BLE frame to %s: %s", address, frame.toString("hex"))
      await withTimeout(characteristic.writeAsync(frame, true), 5000, `timed out writing to ${address}`)
      await delay(100)
    } finally {
      await this.stopScanning()
      await this.cleanupPeripheral(peripheral)
    }
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
    let onDiscover: ((candidate: Peripheral) => void) | undefined
    const peripheralPromise = new Promise<Peripheral>((resolve) => {
      onDiscover = (candidate: Peripheral) => {
        this.log.debug(
          "discovered BLE device %s (%s)",
          candidate.address,
          candidate.advertisement.localName ?? "unnamed",
        )
        if (normalizeAddress(candidate.address) === address) {
          this.noble.removeListener("discover", onDiscover!)
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
    const { characteristics } = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [GOVEE_SERVICE_UUID],
        [GOVEE_WRITE_UUID],
      ),
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

  private async cleanupPeripheral(peripheral?: Peripheral): Promise<void> {
    if (peripheral?.state === "connecting") {
      peripheral.cancelConnect()
      return
    }
    if (peripheral?.state !== "connected") {
      return
    }

    await withTimeout(
      peripheral.disconnectAsync(),
      DISCONNECT_TIMEOUT,
      `timed out disconnecting from ${peripheral.address}`,
    ).catch(error => this.log.debug("BLE cleanup failed: %s", errorMessage(error)))
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
