import type { PlatformConfig } from "homebridge"

export interface DeviceConfig {
  name: string
  address: string
  model?: "H61E0"
}

export interface GoveePlatformConfig extends PlatformConfig {
  devices?: DeviceConfig[]
  hciDeviceId?: number
  scanTimeout?: number
  connectTimeout?: number
  commandRetries?: number
}

export interface GoveeAccessoryContext {
  device?: DeviceConfig
  state?: {
    on: boolean
    brightness: number
    hue: number
    saturation: number
    colorTemperature: number
  }
}
