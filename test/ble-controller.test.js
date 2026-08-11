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
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      connected = true
      this.state = "connected"
    },
    async disconnectAsync() {
      disconnected = true
      this.state = "disconnected"
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

it("cancels a timed-out connection without blocking the next command", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let scanCount = 0
  let cancelled = false
  let secondWrite = false

  const timedOutPeripheral = {
    address,
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    connectAsync() {
      this.state = "connecting"
      return new Promise(() => {})
    },
    cancelConnect() {
      cancelled = true
      this.state = "disconnected"
    },
    async disconnectAsync() {
      throw new Error("disconnect must not run while connecting")
    },
  }
  const workingPeripheral = {
    address,
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      this.state = "connected"
    },
    async disconnectAsync() {
      this.state = "disconnected"
    },
    async discoverSomeServicesAndCharacteristicsAsync() {
      return {
        services: [],
        characteristics: [{
          uuid: "000102030405060708090a0b0c0d2b11",
          async writeAsync() {
            secondWrite = true
          },
        }],
      }
    },
  }
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      const peripheral = scanCount++ === 0 ? timedOutPeripheral : workingPeripheral
      setImmediate(() => noble.emit("discover", peripheral))
    },
    async stopScanningAsync() {},
  })
  const log = { debug() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 20,
    commandRetries: 0,
  }, noble)

  await assert.rejects(controller.send(address, createPowerFrame(true)), /timed out connecting/)
  await controller.send(address, createPowerFrame(false))

  assert.equal(cancelled, true)
  assert.equal(secondWrite, true)
})
