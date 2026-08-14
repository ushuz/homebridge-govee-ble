const PACKET_SIZE = 20

export const Command = {
  power: 0x01,
  brightness: 0x04,
  color: 0x05,
} as const

export function createFrame(command: number, payload: number | number[]): Buffer {
  const data = Array.isArray(payload) ? payload : [payload]
  const content = Buffer.from([0x33, command, ...data])

  if (content.length > PACKET_SIZE - 1) {
    throw new RangeError("Govee command payload is too long")
  }

  const frame = Buffer.alloc(PACKET_SIZE)
  content.copy(frame)

  let checksum = 0
  for (const byte of frame.subarray(0, PACKET_SIZE - 1)) {
    checksum ^= byte
  }
  frame[PACKET_SIZE - 1] = checksum

  return frame
}

export function createPowerFrame(on: boolean): Buffer {
  return createFrame(Command.power, on ? 0x01 : 0x00)
}

/** 0xaa query — device replies on the notify characteristic (0xee / 0xaa) */
export function createStatusFrame(): Buffer {
  const frame = Buffer.alloc(PACKET_SIZE)
  frame[0] = 0xaa
  frame[1] = Command.power
  let checksum = 0
  for (const byte of frame.subarray(0, PACKET_SIZE - 1)) {
    checksum ^= byte
  }
  frame[PACKET_SIZE - 1] = checksum
  return frame
}

/** parse a notify payload from a status query (power at byte 2) */
export function parseStatusPacket(buffer: Buffer): { on: boolean } | null {
  if (!buffer || buffer.length < 3) {
    return null
  }
  const header = buffer[0]
  const command = buffer[1]
  if ((header !== 0xee && header !== 0xaa) || command !== Command.power) {
    return null
  }
  return { on: buffer[2] !== 0 }
}

export function createBrightnessFrame(brightness: number): Buffer {
  const normalized = clamp(Math.round(brightness), 0, 100)
  return createFrame(Command.brightness, Math.floor(normalized * 0xff / 100))
}

export function createColorFrame(red: number, green: number, blue: number): Buffer {
  return createFrame(Command.color, [
    0x02,
    clamp(Math.round(red), 0, 255),
    clamp(Math.round(green), 0, 255),
    clamp(Math.round(blue), 0, 255),
  ])
}

export function hsbToRgb(hue: number, saturation: number): [number, number, number] {
  const normalizedHue = ((hue % 360) + 360) % 360
  const normalizedSaturation = clamp(saturation, 0, 100) / 100
  const chroma = normalizedSaturation
  const section = normalizedHue / 60
  const intermediate = chroma * (1 - Math.abs(section % 2 - 1))

  let red = 0
  let green = 0
  let blue = 0

  if (section < 1) {
    red = chroma
    green = intermediate
  } else if (section < 2) {
    red = intermediate
    green = chroma
  } else if (section < 3) {
    green = chroma
    blue = intermediate
  } else if (section < 4) {
    green = intermediate
    blue = chroma
  } else if (section < 5) {
    red = intermediate
    blue = chroma
  } else {
    red = chroma
    blue = intermediate
  }

  const match = 1 - chroma
  return [red, green, blue].map(value => Math.round((value + match) * 255)) as [number, number, number]
}

export function colorTemperatureToRgb(mired: number): [number, number, number] {
  const kelvin = clamp(1_000_000 / mired, 2000, 6500)
  const temperature = kelvin / 100

  let red: number
  let green: number
  let blue: number

  if (temperature <= 66) {
    red = 255
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661
    blue = temperature <= 19
      ? 0
      : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307
  } else {
    red = 329.698727446 * (temperature - 60) ** -0.1332047592
    green = 288.1221695283 * (temperature - 60) ** -0.0755148492
    blue = 255
  }

  return [red, green, blue].map(value => clamp(Math.round(value), 0, 255)) as [number, number, number]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
