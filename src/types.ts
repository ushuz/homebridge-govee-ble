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
  /** seconds between session keep-alives; 0 disables. default 2 */
  keepAliveInterval?: number
  /** seconds to hold the link after the last command; 0 keeps it open. default 8 */
  idleDisconnect?: number
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
