const assert = require("node:assert/strict")
const { it } = require("node:test")

const { GoveeLightAccessory } = require("../lib/accessory")
const { colorTemperatureToRgb, createColorFrame } = require("../lib/protocol")

it("lets color temperature supersede a pending hue and saturation update", async () => {
  const handlers = new Map()
  const characteristic = name => ({
    onGet(handler) {
      handlers.set(`get:${name}`, handler)
      return this
    },
    onSet(handler) {
      handlers.set(`set:${name}`, handler)
      return this
    },
    setProps() {
      return this
    },
  })
  const lightService = {
    setCharacteristic() {
      return this
    },
    getCharacteristic: characteristic,
    updateCharacteristic() {
      return this
    },
  }
  const informationService = {
    setCharacteristic() {
      return this
    },
  }
  const Characteristic = {
    Manufacturer: "Manufacturer",
    Model: "Model",
    SerialNumber: "SerialNumber",
    Name: "Name",
    On: "On",
    Brightness: "Brightness",
    Hue: "Hue",
    Saturation: "Saturation",
    ColorTemperature: "ColorTemperature",
  }
  const Service = {
    AccessoryInformation: "AccessoryInformation",
    Lightbulb: "Lightbulb",
  }
  const platform = {
    log: { info() {}, error() {} },
    Characteristic,
    Service,
    api: { hap: { HapStatusError: Error } },
  }
  const accessory = {
    displayName: "LED Strip",
    context: {
      device: {
        name: "LED Strip",
        address: "aa:bb:cc:dd:ee:ff",
        model: "H61E0",
      },
    },
    getService(service) {
      return service === Service.AccessoryInformation ? informationService : lightService
    },
    addService() {
      return lightService
    },
  }
  const frames = []
  const ble = {
    async send(address, frame) {
      frames.push({ address, frame })
    },
  }
  new GoveeLightAccessory(platform, accessory, ble)

  const hue = handlers.get("set:Hue")(120)
  const saturation = handlers.get("set:Saturation")(100)
  const colorTemperature = handlers.get("set:ColorTemperature")(250)
  await Promise.all([hue, saturation, colorTemperature])
  await new Promise(resolve => setTimeout(resolve, 200))

  const [red, green, blue] = colorTemperatureToRgb(250)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].frame.toString("hex"), createColorFrame(red, green, blue).toString("hex"))
})
