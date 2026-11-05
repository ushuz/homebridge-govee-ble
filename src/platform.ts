import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
} from "homebridge"

import { GoveeLightAccessory } from "./accessory"
import { resolveHciDeviceId } from "./ble/adapterLock"
import { BleController } from "./ble-controller"
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings"
import type { DeviceConfig, GoveeAccessoryContext, GoveePlatformConfig } from "./types"

export class GoveeBlePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service
  readonly Characteristic: typeof Characteristic
  readonly accessories = new Map<string, PlatformAccessory<GoveeAccessoryContext>>()
  private readonly lights = new Map<string, GoveeLightAccessory>()
  private readonly ble: BleController
  private readonly config: GoveePlatformConfig

  constructor(
    readonly log: Logger,
    config: GoveePlatformConfig,
    readonly api: API,
  ) {
    this.config = config
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    // explicit config wins; else NOBLE_HCI_DEVICE_ID env (legacy); else 0
    const hciDeviceId = resolveHciDeviceId(config.hciDeviceId)

    this.ble = new BleController(log, {
      scanTimeout: (config.scanTimeout ?? 10) * 1000,
      connectTimeout: (config.connectTimeout ?? 10) * 1000,
      commandRetries: config.commandRetries ?? 1,
      hciDeviceId,
      ...optionalMilliseconds(config.keepAliveInterval),
      ...optionalIdleMilliseconds(config.idleDisconnect),
    })

    api.on("didFinishLaunching", () => {
      this.discoverDevices()
      // a full scan holds the shared adapter lock for scanTimeout. skip it
      // when an address is already configured so commands and peer plugins
      // (airthings) are not stuck behind discovery on every restart.
      const configured = hasUsableDeviceConfig(this.config.devices)
      if (configured) {
        this.log.info("Skipping startup BLE scan; a strip address is already configured")
      }
      const scan = configured ? Promise.resolve() : this.ble.discoverGoveeDevices()
      void scan
        .then(() => this.syncLights())
        .catch(error => this.log.warn("Govee BLE discovery failed: %s", errorMessage(error)))
    })

    api.on("shutdown", () => {
      void this.ble.stop()
    })
  }

  configureAccessory(accessory: PlatformAccessory<GoveeAccessoryContext>): void {
    this.accessories.set(accessory.UUID, accessory)
  }

  private discoverDevices(): void {
    const configuredUuids = new Set<string>()

    if (!this.config.devices?.length) {
      this.log.warn("No Govee H61E0 devices are configured")
    }

    for (const device of this.config.devices ?? []) {
      if (!this.isValidDevice(device)) {
        continue
      }

      const uuid = this.api.hap.uuid.generate(`govee-ble:${device.address.toLowerCase()}`)
      if (configuredUuids.has(uuid)) {
        this.log.error("Skipping duplicate BLE address %s", device.address)
        continue
      }
      configuredUuids.add(uuid)
      let accessory = this.accessories.get(uuid)

      if (accessory) {
        accessory.context.device = device
        accessory.displayName = device.name
        this.api.updatePlatformAccessories([accessory])
      } else {
        accessory = new this.api.platformAccessory<GoveeAccessoryContext>(device.name, uuid)
        accessory.context.device = device
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.set(uuid, accessory)
      }

      this.lights.set(uuid, new GoveeLightAccessory(this, accessory, this.ble))
      this.log.info("Configured %s (%s) at %s", device.name, device.model ?? "H61E0", device.address)
    }

    const staleAccessories = [...this.accessories.values()]
      .filter(accessory => !configuredUuids.has(accessory.UUID))
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories)
      for (const accessory of staleAccessories) {
        this.accessories.delete(accessory.UUID)
      }
    }
  }

  private async syncLights(): Promise<void> {
    for (const light of this.lights.values()) {
      await light.syncFromDevice()
    }
  }

  private isValidDevice(device: DeviceConfig): boolean {
    if (!device.name || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(device.address)) {
      this.log.error("Skipping invalid device configuration: name and BLE address are required")
      return false
    }
    if (device.model && device.model !== "H61E0") {
      this.log.error("Skipping %s: model %s is not supported", device.name, device.model)
      return false
    }
    return true
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** true when startup discovery can be skipped because a strip address is configured */
export function hasUsableDeviceConfig(devices: DeviceConfig[] | undefined): boolean {
  return (devices ?? []).some((device) => isUsableDevice(device))
}

function isUsableDevice(device: DeviceConfig | undefined): boolean {
  if (!device?.name || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(device.address ?? "")) {
    return false
  }
  if (device.model && device.model !== "H61E0") {
    return false
  }
  return true
}

/** config seconds -> controller ms; undefined keeps the controller default, 0 disables */
function optionalMilliseconds(
  seconds: number | undefined,
): { keepAliveIntervalMs: number } | Record<string, never> {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return {}
  }
  return { keepAliveIntervalMs: Math.max(0, seconds) * 1000 }
}

function optionalIdleMilliseconds(
  seconds: number | undefined,
): { idleDisconnectMs: number } | Record<string, never> {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return {}
  }
  return { idleDisconnectMs: Math.max(0, seconds) * 1000 }
}
