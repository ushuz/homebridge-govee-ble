import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
} from "homebridge"

import { GoveeLightAccessory } from "./accessory"
import { BleController } from "./ble-controller"
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings"
import type { DeviceConfig, GoveeAccessoryContext, GoveePlatformConfig } from "./types"

export class GoveeBlePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service
  readonly Characteristic: typeof Characteristic
  readonly accessories = new Map<string, PlatformAccessory<GoveeAccessoryContext>>()
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

    process.env.NOBLE_HCI_DEVICE_ID = String(config.hciDeviceId ?? 0)
    process.env.NOBLE_REPORT_ALL_HCI_EVENTS = "1"

    this.ble = new BleController(log, {
      scanTimeout: (config.scanTimeout ?? 10) * 1000,
      connectTimeout: (config.connectTimeout ?? 10) * 1000,
      commandRetries: config.commandRetries ?? 1,
    })

    api.on("didFinishLaunching", () => {
      this.discoverDevices()
      void this.ble.discoverGoveeDevices()
        .catch(error => this.log.warn("Govee BLE discovery failed: %s", errorMessage(error)))
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

      new GoveeLightAccessory(this, accessory, this.ble)
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
