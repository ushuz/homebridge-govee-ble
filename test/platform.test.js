const assert = require("node:assert/strict")
const { describe, it } = require("node:test")

const { hasUsableDeviceConfig } = require("../lib/platform")

describe("startup scan", () => {
  it("scans only when no usable strip address is configured", () => {
    assert.equal(hasUsableDeviceConfig(undefined), false)
    assert.equal(hasUsableDeviceConfig([]), false)
    assert.equal(hasUsableDeviceConfig([{ name: "", address: "aa:bb:cc:dd:ee:ff" }]), false)
    assert.equal(hasUsableDeviceConfig([{ name: "Strip", address: "not-a-mac" }]), false)
    assert.equal(hasUsableDeviceConfig([
      { name: "Strip", address: "aa:bb:cc:dd:ee:ff", model: "H6199" },
    ]), false)
    assert.equal(hasUsableDeviceConfig([
      { name: "Strip", address: "aa:bb:cc:dd:ee:ff" },
    ]), true)
    assert.equal(hasUsableDeviceConfig([
      { name: "Strip", address: "AA:BB:CC:DD:EE:FF", model: "H61E0" },
    ]), true)
  })
})
