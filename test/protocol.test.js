const assert = require("node:assert/strict")
const { describe, it } = require("node:test")

const {
  colorTemperatureToRgb,
  createBrightnessFrame,
  createColorFrame,
  createPowerFrame,
  createStatusFrame,
  hsbToRgb,
  parseStatusPacket,
} = require("../lib/protocol")

describe("Govee protocol", () => {
  it("creates a 20-byte power frame with an XOR checksum", () => {
    assert.equal(createPowerFrame(true).toString("hex"), "3301010000000000000000000000000000000033")
    assert.equal(createPowerFrame(false).toString("hex"), "3301000000000000000000000000000000000032")
  })

  it("scales brightness to the H61E0 0xff range", () => {
    assert.equal(createBrightnessFrame(0).toString("hex"), "3304000000000000000000000000000000000037")
    assert.equal(createBrightnessFrame(100).toString("hex"), "3304ff00000000000000000000000000000000c8")
  })

  it("creates a manual RGB frame", () => {
    assert.equal(createColorFrame(255, 128, 0).toString("hex"), "330502ff8000000000000000000000000000004b")
  })

  it("converts HomeKit hue and saturation to RGB", () => {
    assert.deepEqual(hsbToRgb(0, 100), [255, 0, 0])
    assert.deepEqual(hsbToRgb(120, 100), [0, 255, 0])
    assert.deepEqual(hsbToRgb(240, 100), [0, 0, 255])
    assert.deepEqual(hsbToRgb(42, 0), [255, 255, 255])
  })

  it("creates a 20-byte status query with an XOR checksum", () => {
    assert.equal(createStatusFrame().toString("hex"), "aa010000000000000000000000000000000000ab")
  })

  it("parses power from a status notify packet", () => {
    assert.deepEqual(parseStatusPacket(Buffer.from("ee0101", "hex")), { on: true })
    assert.deepEqual(parseStatusPacket(Buffer.from("ee0100", "hex")), { on: false })
    assert.equal(parseStatusPacket(Buffer.from("330101", "hex")), null)
  })

  it("converts HomeKit color temperature to bounded RGB", () => {
    assert.deepEqual(colorTemperatureToRgb(500), [255, 137, 14])
    assert.deepEqual(colorTemperatureToRgb(154), [255, 254, 250])
  })
})
