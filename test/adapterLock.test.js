const assert = require("node:assert/strict")
const { rmSync } = require("node:fs")
const { afterEach, describe, it } = require("node:test")

const {
  bleAdapterLockPath,
  withBleAdapterLock,
} = require("../lib/ble/adapterLock")

const HCI = 98 // avoid colliding with live homebridge locks

afterEach(() => {
  try {
    rmSync(bleAdapterLockPath(HCI), { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("withBleAdapterLock", () => {
  it("serializes concurrent holders", async () => {
    const order = []

    const a = withBleAdapterLock(
      { owner: "a", hciDeviceId: HCI, pollIntervalMs: 20, acquireTimeoutMs: 5000 },
      async () => {
        order.push("a-start")
        await new Promise((r) => setTimeout(r, 80))
        order.push("a-end")
        return "a"
      },
    )

    await new Promise((r) => setTimeout(r, 10))

    const b = withBleAdapterLock(
      { owner: "b", hciDeviceId: HCI, pollIntervalMs: 20, acquireTimeoutMs: 5000 },
      async () => {
        order.push("b-start")
        order.push("b-end")
        return "b"
      },
    )

    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra, "a")
    assert.equal(rb, "b")
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"])
  })

  it("releases after failure so the next holder can run", async () => {
    await assert.rejects(
      () =>
        withBleAdapterLock(
          { owner: "fail", hciDeviceId: HCI, acquireTimeoutMs: 2000 },
          async () => {
            throw new Error("boom")
          },
        ),
      /boom/,
    )

    const result = await withBleAdapterLock(
      { owner: "ok", hciDeviceId: HCI, acquireTimeoutMs: 2000 },
      async () => "ok",
    )
    assert.equal(result, "ok")
  })
})
