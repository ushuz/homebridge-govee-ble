const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { describe, it } = require("node:test")

const {
  childPathsFromIntrospect,
  ensureDiscovery,
  hardenDevice,
  isDiscoveryBusyError,
  patchGattServerInit,
  waitForTruthyProperty,
} = require("../lib/ble/nodeBle")

describe("node-ble guards", () => {
  it("parses BlueZ introspect child nodes as full object paths", () => {
    const xml = `
      <node>
        <node name="dev_AA_BB_CC_DD_EE_FF"/>
        <node name="dev_11_22_33_44_55_66"/>
      </node>`
    assert.deepEqual(childPathsFromIntrospect("/org/bluez/hci0", xml), [
      "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
      "/org/bluez/hci0/dev_11_22_33_44_55_66",
    ])
  })

  it("treats BlueZ InProgress as a busy discovery session", () => {
    const inProgress = new Error("InProgress")
    inProgress.type = "org.bluez.Error.InProgress"
    assert.equal(isDiscoveryBusyError(inProgress), true)
    assert.equal(isDiscoveryBusyError(new Error("Discovery already in progress")), true)
    assert.equal(isDiscoveryBusyError(new Error("Not Ready")), false)
  })

  it("does not power-cycle the adapter when discovery is already in progress", async () => {
    let powerChanges = 0
    const adapter = {
      async isDiscovering() { return false },
      async startDiscovery() {
        const error = new Error("InProgress")
        error.type = "org.bluez.Error.InProgress"
        throw error
      },
      async stopDiscovery() {},
      helper: {
        async set() { powerChanges += 1 },
      },
    }

    assert.equal(await ensureDiscovery(adapter), false)
    assert.equal(powerChanges, 0)
  })

  it("subscribes to disconnect when BlueZ is already connected", async () => {
    const helper = new EventEmitter()
    let connected = true
    const device = new EventEmitter()
    device.helper = helper
    device.isConnected = async () => connected
    device.connect = async () => { connected = true }
    device.disconnect = async () => { connected = false }
    device.gatt = async () => ({ async services() { return [] } })

    const hardened = hardenDevice(device)
    let disconnected = false
    hardened.on("disconnect", () => { disconnected = true })
    await hardened.connect()
    helper.emit("PropertiesChanged", { Connected: { value: false } })
    assert.equal(disconnected, true)
  })

  it("drops a cached GATT server when the link goes down", async () => {
    const helper = new EventEmitter()
    let connected = true
    let generation = 0
    const device = new EventEmitter()
    device.helper = helper
    device.isConnected = async () => connected
    device.connect = async () => { connected = true }
    device.disconnect = async () => { connected = false }
    device.gatt = async () => {
      const id = ++generation
      return { async services() { return [`service-${id}`] } }
    }

    const hardened = hardenDevice(device)
    await hardened.connect()
    const first = await hardened.gatt()
    assert.deepEqual(await first.services(), ["service-1"])
    assert.equal(await hardened.gatt(), first)

    connected = false
    helper.emit("PropertiesChanged", { Connected: { value: false } })
    const second = await hardened.gatt()
    assert.notEqual(second, first)
    assert.deepEqual(await second.services(), ["service-2"])
  })

  it("resolves a truthy property that changes without a signal", async () => {
    let value = false
    setTimeout(() => { value = true }, 30)
    await waitForTruthyProperty(
      async () => value,
      () => () => {},
      400,
      "timed out waiting",
      20,
    )
  })

  it("rejects a property wait instead of hanging", async () => {
    await assert.rejects(
      () => waitForTruthyProperty(
        async () => false,
        () => () => {},
        80,
        "timed out waiting",
        20,
      ),
      /timed out waiting/,
    )
  })

  it("GATT init completes when ServicesResolved flips without a signal", async () => {
    patchGattServerInit(500)
    const GattServer = require("node-ble/src/GattServer")
    let resolved = false
    setTimeout(() => { resolved = true }, 40)
    const server = Object.create(GattServer.prototype)
    server.dbus = {}
    server.adapter = "hci0"
    server.device = "dev_TEST"
    server.helper = {
      iface: "org.bluez.Device1",
      _propsProxy: {
        on() {},
        off() {},
      },
      async prop(name) {
        assert.equal(name, "ServicesResolved")
        return resolved
      },
      async children() { return [] },
      // the unpatched node-ble init waits here forever if the signal is missed
      waitPropChange() { return new Promise(() => {}) },
    }

    await server.init()
    assert.deepEqual(server._services, {})
  })
})
