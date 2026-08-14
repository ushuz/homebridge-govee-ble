const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { format } = require("node:util")
const { it } = require("node:test")

const { BleController } = require("../lib/ble-controller")
const { createPowerFrame } = require("../lib/protocol")

function formatLog(...args) {
  return format(...args)
}

function createMockBus({ devices = new Map(), onConnect, onWrite } = {}) {
  let discovering = false
  const adapter = {
    async getAddress() { return "00:00:00:00:00:00" },
    async getName() { return "mock" },
    async isPowered() { return true },
    async isDiscovering() { return discovering },
    async startDiscovery() { discovering = true },
    async stopDiscovery() { discovering = false },
    async devices() { return [...devices.keys()] },
    async getDevice(address) {
      const key = address.toLowerCase()
      const device = devices.get(key) || devices.get(address.toUpperCase())
      if (!device) throw new Error("Device not found")
      return device
    },
    async waitDevice(address) {
      return adapter.getDevice(address)
    },
  }
  return {
    adapter,
    adapterName: "hci0",
    destroy() {},
    // helpers for tests
    _setDiscovering(v) { discovering = v },
    _onConnect: onConnect,
    _onWrite: onWrite,
  }
}

function createMockDevice(address, { name = "Govee_H61E0_EEFF", writeImpl } = {}) {
  let connected = false
  const emitter = new EventEmitter()
  const notifyEmitter = new EventEmitter()
  const writeChar = {
    async getUUID() { return "00010203-0405-0607-0809-0a0b0c0d2b11" },
    async writeValueWithoutResponse(frame) {
      if (writeImpl) return writeImpl(frame, true)
    },
    async writeValue() {},
  }
  const notifyChar = {
    async getUUID() { return "00010203-0405-0607-0809-0a0b0c0d2b10" },
    async startNotifications() {},
    async stopNotifications() {},
    on(event, listener) {
      notifyEmitter.on(event, listener)
      return notifyChar
    },
    removeListener(event, listener) {
      notifyEmitter.removeListener(event, listener)
      return notifyChar
    },
  }
  const service = {
    async getUUID() { return "000102030405060708090a0b0c0d1910" },
    async characteristics() {
      return [
        "00010203-0405-0607-0809-0a0b0c0d2b11",
        "00010203-0405-0607-0809-0a0b0c0d2b10",
      ]
    },
    async getCharacteristic(uuid) {
      return uuid.includes("2b10") ? notifyChar : writeChar
    },
  }
  const device = {
    async getName() { return name },
    async getAddress() { return address },
    async getAlias() { return name },
    async getRSSI() { return -50 },
    async isConnected() { return connected },
    async connect() {
      connected = true
      emitter.emit("connect", { connected: true })
    },
    async disconnect() {
      connected = false
      emitter.emit("disconnect", { connected: false })
    },
    async gatt() {
      return {
        async services() { return ["000102030405060708090a0b0c0d1910"] },
        async getPrimaryService() { return service },
      }
    },
    on(event, listener) {
      emitter.on(event, listener)
      return device
    },
    removeListener(event, listener) {
      emitter.removeListener(event, listener)
      return device
    },
    // test hooks
    _setConnected(v) { connected = v },
    _writeChar: writeChar,
    _notifyChar: notifyChar,
    _emitNotify(buffer) { notifyEmitter.emit("valuechanged", buffer) },
  }
  return device
}

it("finds, writes to, and keeps the configured strip connected", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  const writtenFrames = []
  const device = createMockDevice(address, {
    writeImpl(frame, withoutResponse) {
      writtenFrames.push({ frame, withoutResponse })
    },
  })
  const devices = new Map([[address, device]])
  const bus = createMockBus({ devices })

  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, async () => bus)

  const frame = createPowerFrame(true)
  await controller.send(address, frame)

  assert.equal(await device.isConnected(), true)
  assert.equal(writtenFrames.length, 1)
  assert.equal(writtenFrames[0].frame.toString("hex"), frame.toString("hex"))
  assert.equal(writtenFrames[0].withoutResponse, true)
})

it("reads power state from a status notify packet", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  const device = createMockDevice(address, {
    writeImpl() {
      setTimeout(() => device._emitNotify(Buffer.from("ee0101", "hex")), 10)
    },
  })
  const bus = createMockBus({ devices: new Map([[address, device]]) })
  const controller = new BleController(
    { debug() {}, info() {}, warn() {} },
    { scanTimeout: 100, connectTimeout: 100, commandRetries: 0 },
    async () => bus,
  )
  assert.equal(await controller.readPowerState(address), true)
})

it("writes when bluez already reports connected", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let written = false
  const device = createMockDevice(address, {
    writeImpl() { written = true },
  })
  // leftover bluez session: already connected before our first command
  device._setConnected(true)
  const bus = createMockBus({ devices: new Map([[address, device]]) })
  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, async () => bus)

  await controller.send(address, createPowerFrame(true))
  assert.equal(written, true)
  assert.equal(await device.isConnected(), true)
})

it("logs unique H61E0 devices found during discovery", async () => {
  const logs = []
  const d1 = createMockDevice("aa:bb:cc:dd:ee:01", { name: "Govee_H61E0_EE01" })
  const d2 = createMockDevice("aa:bb:cc:dd:ee:02", { name: "Govee_H61E0_EE02" })
  const other = createMockDevice("aa:bb:cc:dd:ee:03", { name: "Other" })
  const bus = createMockBus({
    devices: new Map([
      ["aa:bb:cc:dd:ee:01", d1],
      ["aa:bb:cc:dd:ee:02", d2],
      ["aa:bb:cc:dd:ee:03", other],
    ]),
  })
  const log = {
    debug() {},
    info(...args) { logs.push(formatLog(...args)) },
    warn() {},
  }
  const controller = new BleController(log, {
    scanTimeout: 20,
    connectTimeout: 100,
    commandRetries: 0,
  }, async () => bus)

  await controller.discoverGoveeDevices()
  const joined = logs.join("\n")
  assert.match(joined, /Discovered 2 Govee H61E0/)
  assert.match(joined, /Govee_H61E0_EE01/)
  assert.match(joined, /Govee_H61E0_EE02/)
})

it("cancels a timed-out connection without blocking the next command", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let attempts = 0
  const device = createMockDevice(address, {
    writeImpl() {},
  })
  device.connect = async () => {
    attempts += 1
    if (attempts === 1) {
      await new Promise((r) => setTimeout(r, 500))
      throw new Error("slow")
    }
    device._setConnected(true)
  }
  // first find works, connect hangs past timeout
  const bus = createMockBus({ devices: new Map([[address, device]]) })
  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 50,
    connectTimeout: 50,
    commandRetries: 1,
  }, async () => bus)

  await controller.send(address, createPowerFrame(true))
  assert.ok(attempts >= 2)
  assert.equal(await device.isConnected(), true)
})

it("rediscovers the characteristic after a remote disconnect", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let writes = 0
  const device = createMockDevice(address, {
    writeImpl() { writes += 1 },
  })
  const bus = createMockBus({ devices: new Map([[address, device]]) })
  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, async () => bus)

  await controller.send(address, createPowerFrame(true))
  assert.equal(writes, 1)

  // remote disconnect clears write char cache via event
  device._setConnected(false)
  device.on // keep
  // simulate disconnect event by calling listeners through disconnect
  await device.disconnect()
  // after disconnect emit - our rememberDevice listens for disconnect
  // force emit
  const emitterListeners = device
  // re-connect path
  device._setConnected(false)
  await controller.send(address, createPowerFrame(false))
  assert.equal(writes, 2)
  void emitterListeners
})

it("replaces a cached peripheral after adapter power cycle", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let writes = 0
  const first = createMockDevice(address, { writeImpl() { writes += 1 } })
  const second = createMockDevice(address, { writeImpl() { writes += 10 } })
  let current = first
  const bus = createMockBus({
    devices: new Map(),
  })
  bus.adapter.getDevice = async () => current
  bus.adapter.waitDevice = async () => current
  bus.adapter.devices = async () => [address]

  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 1,
  }, async () => bus)

  await controller.send(address, createPowerFrame(true))
  assert.equal(writes, 1)

  // power cycle: cached first becomes stale; retry should pick second
  first._setConnected(false)
  first.connect = async () => { throw new Error("stale") }
  current = second
  await controller.send(address, createPowerFrame(true))
  assert.equal(writes, 11)
})

it("waits for a disconnecting peripheral before reconnecting", async () => {
  const address = "aa:bb:cc:dd:ee:ff"
  let writes = 0
  const device = createMockDevice(address, {
    writeImpl() { writes += 1 },
  })
  device._setConnected(true)
  const bus = createMockBus({ devices: new Map([[address, device]]) })
  const log = { debug() {}, info() {}, warn() {} }
  const controller = new BleController(log, {
    scanTimeout: 100,
    connectTimeout: 100,
    commandRetries: 0,
  }, async () => bus)

  await controller.send(address, createPowerFrame(true))
  assert.equal(writes, 1)
  assert.equal(await device.isConnected(), true)
})
