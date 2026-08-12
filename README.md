# @ushuz/homebridge-govee-ble

Local-only Homebridge control for the Govee H61E0 LED strip over BLE. The
plugin exposes power, brightness, hue, saturation, and color temperature. It
does not require a Govee account, API key, Wi-Fi, or internet access.

BLE stack: [`node-ble`](https://www.npmjs.com/package/node-ble) (BlueZ over
D-Bus, pure JavaScript — no native HCI bindings). **Linux only**.

## Supported environment

- Homebridge 1.8.5
- Node.js 20.18.0
- Raspberry Pi OS Bookworm / Homebridge OS
- BlueZ Bluetooth adapter
- Govee H61E0

## Raspberry Pi setup

Install the Bluetooth packages:

```sh
sudo apt update
sudo apt install --no-install-recommends bluetooth bluez
sudo systemctl enable --now bluetooth
```

`node-ble` talks to BlueZ on the system D-Bus. Ensure the Homebridge user can
use `org.bluez` (e.g. `bluetooth` group, or a D-Bus policy from the
[node-ble README](https://github.com/chrvadala/node-ble#provide-permissions)).

No `setcap` / raw HCI capabilities are required (unlike noble).

Find the strip's BLE address while the Govee app is disconnected:

```sh
bluetoothctl scan on
```

Look for a device named like `Govee_H61E0_XXXX`. Copy its colon-separated BLE
address, then stop the scan with `bluetoothctl scan off`.

Close the Govee app before using the plugin. After the first successful
command, the plugin keeps the BLE session open to avoid repeated connection
setup on Raspberry Pi. The app cannot connect until Homebridge stops or the
BLE session drops.

The plugin also scans at startup and logs each nearby H61E0:

```text
Scanning for Govee H61E0 devices (10s)...
Discovered 1 Govee H61E0 device(s)
  - Govee_H61E0_0C6A address=aa:bb:cc:dd:ee:ff rssi=-57
```

You can initially configure `"devices": []`, restart Homebridge, and copy the
address from this log before adding the device configuration.

## Install

```sh
hb-service add @ushuz/homebridge-govee-ble
# or
npm install -g @ushuz/homebridge-govee-ble
```

Restart Homebridge after install.

To work on the plugin from source:

```sh
git clone https://github.com/ushuz/homebridge-govee-ble.git
cd homebridge-govee-ble
npm install
npm test
npm run build
```

## Configure

Add the platform to the Homebridge `config.json`, or use the Homebridge UI:

```json
{
  "platform": "GoveeBLE",
  "name": "Govee BLE",
  "devices": [
    {
      "name": "LED Strip",
      "address": "aa:bb:cc:dd:ee:ff",
      "model": "H61E0"
    }
  ],
  "hciDeviceId": 0,
  "scanTimeout": 10,
  "connectTimeout": 10,
  "commandRetries": 1
}
```

`hciDeviceId` corresponds to `hci0`, `hci1`, and so on.

### Sharing the adapter with other BLE plugins

Both this plugin and `@ushuz/homebridge-airthings-ble` use **node-ble** (BlueZ
D-Bus), so they no longer fight over exclusive raw HCI sockets. They still take
a short-lived directory lock (`$TMPDIR/homebridge-ble-hci{N}.lock/`) around
scan/connect so only one plugin drives the radio at a time. Set the same
`hciDeviceId` on both.

## Behavior and limitations

- BLE operations are serialized so simultaneous HomeKit changes cannot compete
  for the Raspberry Pi's single adapter. The same lock also coordinates with
  peer BLE plugins that implement the shared protocol.
- A successful connection and control characteristic are reused until the strip
  disconnects. The plugin then reconnects and discovers the characteristic
  again.
- H61E0 does not provide reliable state reads through this protocol. Homebridge
  therefore reports the last state it successfully sent. Changes made with the
  Govee app or inline controller are not reflected until Homebridge sends a new
  value.
- Color temperature is approximated with RGB because HomeKit exposes color
  temperature separately while this BLE protocol accepts an RGB color.
- Segment effects, music modes, scenes, and animations are outside the current
  scope.

## Troubleshooting

Run Homebridge in debug mode and look for BLE discovery and frame logs:

```sh
homebridge -D
```

- `no bluetooth adapters found via bluez`: install/enable BlueZ
- `bluetooth adapter hci0 is not powered`: `sudo rfkill unblock bluetooth`
- D-Bus permission errors: configure `org.bluez` policy for the homebridge user
- `could not find Govee strip`: verify the address and close the Govee app

## Protocol

Commands are 20 bytes: `0x33`, command, payload, zero padding, and an XOR of the
first 19 bytes. H61E0 uses service UUID
`00010203-0405-0607-0809-0a0b0c0d1910` and write characteristic UUID
`00010203-0405-0607-0809-0a0b0c0d2b11`.
