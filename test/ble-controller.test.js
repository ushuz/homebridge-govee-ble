const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { it } = require("node:test")

const { BleController } = require("../lib/ble-controller")
const { createPowerFrame } = require("../lib/protocol")

it("finds, writes to, and keeps the configured strip connected", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  const writtenFrames = []
  let connected = false
  let disconnected = false

  const peripheral = Object.assign(new EventEmitter(), {
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
    async discoverServicesAsync() {
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [{
            uuid: "00010203-0405-0607-0809-0a0b0c0d2b11",
            async writeAsync(frame, withoutResponse) {
              writtenFrames.push({ frame, withoutResponse })
            },
          }]
        },
      }]
    },
  })

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
  assert.equal(disconnected, false)
  assert.equal(writtenFrames.length, 1)
  assert.equal(writtenFrames[0].frame.toString("hex"), frame.toString("hex"))
  assert.equal(writtenFrames[0].withoutResponse, true)
})

it("reuses an existing connection instead of reconnecting", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let connectCalled = false
  let written = false
  const peripheral = Object.assign(new EventEmitter(), {
    address,
    state: "connected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      connectCalled = true
    },
    async disconnectAsync() {
      this.state = "disconnected"
    },
    async discoverServicesAsync() {
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [{
            uuid: "000102030405060708090a0b0c0d2b11",
            async writeAsync() {
              written = true
            },
          }]
        },
      }]
    },
  })
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      setImmediate(() => noble.emit("discover", peripheral))
    },
    async stopScanningAsync() {},
  })
  const controller = new BleController({ debug() {} }, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  await controller.send(address, createPowerFrame(true))

  assert.equal(connectCalled, false)
  assert.equal(written, true)
})

it("logs unique H61E0 devices found during discovery", async () => {
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      setImmediate(() => {
        noble.emit("discover", Object.assign(new EventEmitter(), {
          id: "govee-id",
          address: "aa:bb:cc:dd:ee:ff",
          rssi: -57,
          advertisement: { localName: "Govee_H61E0_0C6A" },
        }))
        noble.emit("discover", Object.assign(new EventEmitter(), {
          id: "govee-id",
          address: "aa:bb:cc:dd:ee:ff",
          rssi: -55,
          advertisement: { localName: "Govee_H61E0_0C6A" },
        }))
        noble.emit("discover", Object.assign(new EventEmitter(), {
          id: "other-id",
          address: "11:22:33:44:55:66",
          rssi: -40,
          advertisement: { localName: "Other_Device" },
        }))
      })
    },
    async stopScanningAsync() {},
  })
  const logs = []
  const log = {
    debug() {},
    info(message, ...parameters) {
      logs.push({ message, parameters })
    },
  }
  const controller = new BleController(log, {
    scanTimeout: 20,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  await controller.discoverGoveeDevices()

  assert.deepEqual(logs.at(-2), {
    message: "Discovered %s Govee H61E0 device(s)",
    parameters: [1],
  })
  assert.deepEqual(logs.at(-1), {
    message: "  - %s address=%s rssi=%s",
    parameters: ["Govee_H61E0_0C6A", "aa:bb:cc:dd:ee:ff", -55],
  })
})

it("cancels a timed-out connection without blocking the next command", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let scanCount = 0
  let connectCount = 0
  let cancelled = false
  let secondWrite = false

  const timedOutPeripheral = Object.assign(new EventEmitter(), {
    address,
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    connectAsync() {
      connectCount += 1
      this.state = "connecting"
      if (connectCount > 1) {
        this.state = "connected"
        return Promise.resolve()
      }
      return new Promise(() => {})
    },
    cancelConnect() {
      cancelled = true
      this.state = "disconnected"
    },
    async disconnectAsync() {
      throw new Error("disconnect must not run while connecting")
    },
    async discoverServicesAsync() {
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [{
            uuid: "000102030405060708090a0b0c0d2b11",
            async writeAsync() {
              secondWrite = true
            },
          }]
        },
      }]
    },
  })
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      scanCount += 1
      setImmediate(() => noble.emit("discover", timedOutPeripheral))
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
  assert.equal(scanCount, 1)
  assert.equal(secondWrite, true)
})

it("rediscovers the characteristic after a remote disconnect", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let scanCount = 0
  let connectCount = 0
  let discoveryCount = 0
  let writeCount = 0
  const characteristic = {
    uuid: "000102030405060708090a0b0c0d2b11",
    async writeAsync() {
      writeCount += 1
    },
  }
  const peripheral = Object.assign(new EventEmitter(), {
    address,
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      connectCount += 1
      this.state = "connected"
    },
    async discoverServicesAsync() {
      discoveryCount += 1
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [characteristic]
        },
      }]
    },
  })
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      scanCount += 1
      setImmediate(() => noble.emit("discover", peripheral))
    },
    async stopScanningAsync() {},
  })
  const controller = new BleController({ debug() {} }, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  await controller.send(address, createPowerFrame(true))
  peripheral.state = "disconnected"
  peripheral.emit("disconnect", 19)
  await controller.send(address, createPowerFrame(false))

  assert.equal(scanCount, 1)
  assert.equal(connectCount, 2)
  assert.equal(discoveryCount, 2)
  assert.equal(writeCount, 2)
})

it("replaces a cached peripheral after an adapter power cycle", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let scanCount = 0
  const writtenBy = []
  const createPeripheral = label => Object.assign(new EventEmitter(), {
    address,
    state: "disconnected",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      this.state = "connected"
    },
    async discoverServicesAsync() {
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [{
            uuid: "000102030405060708090a0b0c0d2b11",
            async writeAsync() {
              writtenBy.push(label)
            },
          }]
        },
      }]
    },
  })
  const firstPeripheral = createPeripheral("first")
  const replacementPeripheral = createPeripheral("replacement")
  let advertisedPeripheral = firstPeripheral
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      scanCount += 1
      setImmediate(() => noble.emit("discover", advertisedPeripheral))
    },
    async stopScanningAsync() {},
  })
  const controller = new BleController({ debug() {} }, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  await controller.send(address, createPowerFrame(true))
  firstPeripheral.state = "disconnected"
  noble.state = "poweredOff"
  noble.emit("stateChange", "poweredOff")
  advertisedPeripheral = replacementPeripheral
  noble.state = "poweredOn"
  noble.emit("stateChange", "poweredOn")
  await controller.send(address, createPowerFrame(false))

  assert.equal(scanCount, 2)
  assert.deepEqual(writtenBy, ["first", "replacement"])
})

it("waits for a disconnecting peripheral before reconnecting", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let connectedWhileDisconnecting = false
  let written = false
  const peripheral = Object.assign(new EventEmitter(), {
    address,
    state: "disconnecting",
    advertisement: { localName: "Govee_H61E0_EEFF" },
    async connectAsync() {
      connectedWhileDisconnecting = this.state === "disconnecting"
      this.state = "connected"
    },
    async discoverServicesAsync() {
      return [{
        uuid: "000102030405060708090a0b0c0d1910",
        async discoverCharacteristicsAsync() {
          return [{
            uuid: "000102030405060708090a0b0c0d2b11",
            async writeAsync() {
              written = true
            },
          }]
        },
      }]
    },
  })
  const noble = Object.assign(new EventEmitter(), {
    state: "poweredOn",
    async waitForPoweredOnAsync() {},
    async startScanningAsync() {
      setImmediate(() => noble.emit("discover", peripheral))
    },
    async stopScanningAsync() {},
  })
  const controller = new BleController({ debug() {} }, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, noble)

  setTimeout(() => {
    peripheral.state = "disconnected"
    peripheral.emit("disconnect", 19)
  }, 20)
  await controller.send(address, createPowerFrame(true))

  assert.equal(connectedWhileDisconnecting, false)
  assert.equal(written, true)
})
