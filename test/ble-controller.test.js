const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { it } = require("node:test")

const { BleController } = require("../lib/ble-controller")
const { createPowerFrame } = require("../lib/protocol")

it("finds, writes to, and disconnects from the configured strip", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  const writtenFrames = []
  let connected = false
  let disconnected = false

  const peripheral = {
    address,
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      connected = true
    },
    async disconnectAsync() {
      disconnected = true
    },
    async discoverSomeServicesAndCharacteristicsAsync() {
      return {
        services: [],
        characteristics: [{
          uuid: "00010203-0405-0607-0809-0a0b0c0d2b11",
          async writeAsync(frame, withoutResponse) {
            writtenFrames.push({ frame, withoutResponse })
          },
        }],
      }
    },
  }

  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      setImmediate(() => noble.emit("discover", peripheral))
    },
    async stopScanningAsync() {},
  })
  const log = { debug() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  const frame = createPowerFrame(true)
  await controller.send(address, frame)

  assert.equal(connected, true)
  assert.equal(disconnected, true)
  assert.equal(writtenFrames.length, 1)
  assert.equal(writtenFrames[0].frame.toString("hex"), frame.toString("hex"))
  assert.equal(writtenFrames[0].withoutResponse, true)
})
