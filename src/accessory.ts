import type { CharacteristicValue, Logger, PlatformAccessory, Service } from "homebridge"

import type { BleController } from "./ble-controller"
import {
  colorTemperatureToRgb,
  createBrightnessFrame,
  createColorFrame,
  createPowerFrame,
  hsbToRgb,
} from "./protocol"
import type { GoveeAccessoryContext } from "./types"
import type { GoveeBlePlatform } from "./platform"

export class GoveeLightAccessory {
  private readonly service: Service
  private readonly log: Logger
  private on = false
  private brightness = 100
  private hue = 0
  private saturation = 0
  private colorTemperature = 370
  private targetHue = 0
  private targetSaturation = 0
  private colorTimer?: NodeJS.Timeout
  private colorWaiters: Array<{ resolve: () => void, reject: (error: unknown) => void }> = []

  constructor(
    private readonly platform: GoveeBlePlatform,
    private readonly accessory: PlatformAccessory<GoveeAccessoryContext>,
    private readonly ble: BleController,
  ) {
    const device = accessory.context.device
    if (!device) {
      throw new Error(`Missing device configuration for ${accessory.displayName}`)
    }

    this.log = platform.log
    const state = accessory.context.state
    this.on = state?.on ?? false
    this.brightness = state?.brightness ?? 100
    this.hue = state?.hue ?? 0
    this.saturation = state?.saturation ?? 0
    this.colorTemperature = state?.colorTemperature ?? 370
    this.targetHue = this.hue
    this.targetSaturation = this.saturation

    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, "Govee")
      .setCharacteristic(platform.Characteristic.Model, device.model ?? "H61E0")
      .setCharacteristic(platform.Characteristic.SerialNumber, device.address.toUpperCase())

    this.service = accessory.getService(platform.Service.Lightbulb)
      ?? accessory.addService(platform.Service.Lightbulb)

    this.service.setCharacteristic(platform.Characteristic.Name, device.name)
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(() => this.on)
      .onSet(value => this.setPower(value))
    this.service.getCharacteristic(platform.Characteristic.Brightness)
      .onGet(() => this.brightness)
      .onSet(value => this.setBrightness(value))
    this.service.getCharacteristic(platform.Characteristic.Hue)
      .onGet(() => this.hue)
      .onSet(value => this.setHue(value))
    this.service.getCharacteristic(platform.Characteristic.Saturation)
      .onGet(() => this.saturation)
      .onSet(value => this.setSaturation(value))
    this.service.getCharacteristic(platform.Characteristic.ColorTemperature)
      .setProps({ minValue: 154, maxValue: 500 })
      .onGet(() => this.colorTemperature)
      .onSet(value => this.setColorTemperature(value))
  }

  /** pull power state from the strip and push it into homekit */
  async syncFromDevice(): Promise<void> {
    const device = this.accessory.context.device
    if (!device) {
      return
    }
    try {
      const on = await this.ble.readPowerState(device.address)
      if (on === null) {
        this.log.warn("[%s] status query returned no power state", this.deviceName())
        return
      }
      if (this.on === on) {
        this.log.info("[%s] power is %s", this.deviceName(), on ? "on" : "off")
        return
      }
      this.log.info(
        "[%s] power is %s (was %s)",
        this.deviceName(),
        on ? "on" : "off",
        this.on ? "on" : "off",
      )
      this.on = on
      this.persistState()
    } catch (error) {
      this.log.warn("[%s] failed to read power state: %s", this.deviceName(), errorMessage(error))
    }
  }

  private async setPower(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value)
    const name = this.deviceName()
    this.log.info("[%s] set power %s", name, on ? "on" : "off")
    await this.send(createPowerFrame(on))
    this.on = on
    this.persistState()
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = Number(value)
    const name = this.deviceName()
    this.log.info("[%s] set brightness %s%%", name, brightness)
    await this.send(createBrightnessFrame(brightness))
    this.brightness = brightness
    this.persistState()
  }

  private setHue(value: CharacteristicValue): Promise<void> {
    this.targetHue = Number(value)
    return this.scheduleColorUpdate()
  }

  private setSaturation(value: CharacteristicValue): Promise<void> {
    this.targetSaturation = Number(value)
    return this.scheduleColorUpdate()
  }

  private async setColorTemperature(value: CharacteristicValue): Promise<void> {
    this.cancelColorUpdate()
    const mired = Number(value)
    const [red, green, blue] = colorTemperatureToRgb(mired)
    const name = this.deviceName()
    this.log.info(
      "[%s] set color temperature %s mired (rgb %s,%s,%s)",
      name,
      mired,
      red,
      green,
      blue,
    )
    await this.send(createColorFrame(red, green, blue))
    this.colorTemperature = mired
    this.persistState()
  }

  private scheduleColorUpdate(): Promise<void> {
    clearTimeout(this.colorTimer)
    this.colorTimer = setTimeout(() => void this.flushColorUpdate(), 150)

    return new Promise((resolve, reject) => {
      this.colorWaiters.push({ resolve, reject })
    })
  }

  private async flushColorUpdate(): Promise<void> {
    this.colorTimer = undefined
    const waiters = this.colorWaiters.splice(0)
    const hue = this.targetHue
    const saturation = this.targetSaturation
    const [red, green, blue] = hsbToRgb(hue, saturation)
    const name = this.deviceName()

    try {
      this.log.info(
        "[%s] set color hue=%s sat=%s (rgb %s,%s,%s)",
        name,
        hue,
        saturation,
        red,
        green,
        blue,
      )
      await this.send(createColorFrame(red, green, blue))
      this.hue = hue
      this.saturation = saturation
      this.persistState()
      for (const waiter of waiters) {
        waiter.resolve()
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error)
      }
    }
  }

  private cancelColorUpdate(): void {
    clearTimeout(this.colorTimer)
    this.colorTimer = undefined
    this.targetHue = this.hue
    this.targetSaturation = this.saturation
    for (const waiter of this.colorWaiters.splice(0)) {
      waiter.resolve()
    }
  }

  private async send(frame: Buffer): Promise<void> {
    const device = this.accessory.context.device!
    try {
      await this.ble.send(device.address, frame)
    } catch (error) {
      this.log.error("[%s] BLE command failed: %s", device.name, errorMessage(error))
      throw new this.platform.api.hap.HapStatusError(-70402)
    }
  }

  private deviceName(): string {
    return this.accessory.context.device?.name ?? this.accessory.displayName
  }

  private persistState(): void {
    this.accessory.context.state = {
      on: this.on,
      brightness: this.brightness,
      hue: this.hue,
      saturation: this.saturation,
      colorTemperature: this.colorTemperature,
    }
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.on)
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
