const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { describe, it } = require("node:test")

const {
  childPathsFromIntrospect,
  ensureDiscovery,
  forgetCachedDevice,
  hardenDevice,
  installNodeBlePatches,
  isDiscoveryBusyError,
  patchGattServerInit,
  releaseDevice,
  stopDiscoveryIfStarted,
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
    let stops = 0
    const adapter = {
      async isDiscovering() { return false },
      async startDiscovery() {
        const error = new Error("InProgress")
        error.type = "org.bluez.Error.InProgress"
        throw error
      },
      async stopDiscovery() { stops += 1 },
      helper: {
        async set() { powerChanges += 1 },
      },
    }

    // InProgress means this dbus client already has a session. the caller
    // must stop it; power-cycling would drop every other connection.
    assert.equal(await ensureDiscovery(adapter), true)
    assert.equal(powerChanges, 0)
    assert.ok(stops >= 1)
  })

  it("stops a discovery session even if Discovering is still false", async () => {
    let session = false
    const adapter = {
      async isDiscovering() { return false },
      async startDiscovery() { throw new Error("guard") },
      async stopDiscovery() { throw new Error("No discovery started") },
      helper: {
        async callMethod(name) {
          if (name === "SetDiscoveryFilter") return
          if (name === "StartDiscovery") {
            session = true
            return
          }
          if (name === "StopDiscovery") {
            if (!session) throw new Error("No discovery started")
            session = false
          }
        },
      },
    }

    assert.equal(await ensureDiscovery(adapter, 1000), true)
    assert.equal(session, true)
    await stopDiscoveryIfStarted(adapter, true, 1000)
    assert.equal(session, false)
  })

  it("restarts a leaked InProgress discovery session instead of leaving it running", async () => {
    let session = true
    let starts = 0
    const adapter = {
      async isDiscovering() { return false },
      async startDiscovery() { throw new Error("guard") },
      async stopDiscovery() { throw new Error("No discovery started") },
      helper: {
        async callMethod(name) {
          if (name === "SetDiscoveryFilter") return
          if (name === "StartDiscovery") {
            starts += 1
            if (session) {
              const error = new Error("InProgress")
              error.type = "org.bluez.Error.InProgress"
              throw error
            }
            session = true
            return
          }
          if (name === "StopDiscovery") {
            session = false
          }
        },
      },
    }

    assert.equal(await ensureDiscovery(adapter, 1000), true)
    assert.equal(session, true)
    assert.ok(starts >= 1)
    await stopDiscoveryIfStarted(adapter, true, 1000)
    assert.equal(session, false)
  })

  it("power-cycles when discovery is stuck on with no devices", async () => {
    let discovering = true
    let session = false
    let power = 0
    let started = 0
    const adapter = {
      async isDiscovering() { return discovering },
      async devices() { return [] },
      async startDiscovery() { throw new Error("guard") },
      async stopDiscovery() { throw new Error("guard") },
      helper: {
        async set() {
          power += 1
          discovering = false
        },
        async callMethod(name) {
          if (name === "SetDiscoveryFilter") return
          if (name === "StartDiscovery") {
            started += 1
            session = true
            discovering = true
            return
          }
          if (name === "StopDiscovery") {
            if (!session) throw new Error("No discovery started")
            session = false
            discovering = false
          }
        },
      },
    }

    assert.equal(await ensureDiscovery(adapter, 1000), true)
    assert.ok(power >= 1)
    assert.equal(started, 1)
    await stopDiscoveryIfStarted(adapter, true, 1000)
    assert.equal(discovering, false)
    assert.equal(session, false)
  })

  it("stops discovery when StartDiscovery times out", async () => {
    let stops = 0
    let discovering = false
    const adapter = {
      async isDiscovering() { return discovering },
      async devices() { return [] },
      async startDiscovery() { throw new Error("guard") },
      async stopDiscovery() { throw new Error("guard") },
      helper: {
        async set() { discovering = false },
        async callMethod(name) {
          if (name === "SetDiscoveryFilter") return
          if (name === "StartDiscovery") {
            discovering = true
            await new Promise(() => {})
          }
          if (name === "StopDiscovery") {
            stops += 1
            discovering = false
          }
        },
      },
    }

    await assert.rejects(
      () => ensureDiscovery(adapter, 40),
      /timed out starting discovery/,
    )
    assert.ok(stops >= 1)
    assert.equal(discovering, false)
  })

  it("does not stack disconnect listeners across connect cycles", async () => {
    const helper = new EventEmitter()
    let connected = false
    const device = new EventEmitter()
    device.helper = helper
    device.isConnected = async () => connected
    device.connect = async () => {
      helper.on("PropertiesChanged", () => {})
      connected = true
    }
    device.disconnect = async () => { connected = false }
    device.gatt = async () => ({ async services() { return [] } })

    const hardened = hardenDevice(device)
    for (let i = 0; i < 3; i += 1) {
      await hardened.connect()
      await hardened.disconnect()
    }
    await hardened.connect()
    assert.equal(helper.listenerCount("PropertiesChanged"), 1)
  })

  it("keeps the properties proxy when node-ble removes listeners", () => {
    installNodeBlePatches()
    const BusHelper = require("node-ble/src/BusHelper")
    const helper = new BusHelper({}, "org.bluez", "/org/bluez/hci0", "org.bluez.Adapter1")
    const proxy = new EventEmitter()
    proxy.on("PropertiesChanged", () => {})
    helper._propsProxy = proxy
    helper._ready = true
    helper.on("PropertiesChanged", () => {})

    helper.removeListeners()

    assert.equal(helper._ready, true)
    assert.equal(helper.listenerCount("PropertiesChanged"), 0)
    assert.equal(proxy.listenerCount("PropertiesChanged"), 1)
  })

  it("releases dbus listeners when a device handle is dropped", () => {
    const proxy = new EventEmitter()
    proxy.on("PropertiesChanged", () => {})
    const helper = new EventEmitter()
    helper._propsProxy = proxy
    helper._ready = true
    const device = new EventEmitter()
    device.helper = helper

    releaseDevice(device)
    releaseDevice(device)

    assert.equal(helper._ready, false)
    assert.equal(proxy.listenerCount("PropertiesChanged"), 0)
  })

  it("forgets a cached device and releases its listeners", () => {
    const proxy = new EventEmitter()
    proxy.on("PropertiesChanged", () => {})
    const helper = new EventEmitter()
    helper._propsProxy = proxy
    helper._ready = true
    const device = new EventEmitter()
    device.helper = helper
    const adapter = {
      __deviceCache: new Map([["AA:BB:CC:DD:EE:FF", device]]),
    }

    forgetCachedDevice(adapter, "aa:bb:cc:dd:ee:ff")

    assert.equal(adapter.__deviceCache.size, 0)
    assert.equal(proxy.listenerCount("PropertiesChanged"), 0)
  })

  it("sends RemoveMatch once dbus-next refcounts a rule", async () => {
    installNodeBlePatches()
    const MessageBus = require("dbus-next/lib/bus")
    const bus = Object.create(MessageBus.prototype)
    bus._matchRules = {}
    bus._connection = { stream: { writable: true } }
    const calls = []
    bus.call = async (msg) => {
      calls.push(msg.member)
    }
    const rule = "type='signal',member='PropertiesChanged'"

    await bus._addMatch(rule)
    await bus._addMatch(rule)
    assert.deepEqual(calls, ["AddMatch"])
    assert.equal(bus._matchRules[rule], 2)

    await bus._removeMatch(rule)
    assert.deepEqual(calls, ["AddMatch"])
    await bus._removeMatch(rule)
    assert.deepEqual(calls, ["AddMatch", "RemoveMatch"])
    assert.equal(bus._matchRules[rule], undefined)
    await bus._removeMatch(rule)
    assert.deepEqual(calls, ["AddMatch", "RemoveMatch"])
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
