# homebridge-govee-ble

Local-only Homebridge control for the Govee H61E0 LED strip over BLE. The
plugin exposes power, brightness, hue, saturation, and color temperature. It
does not require a Govee account, API key, Wi-Fi, or internet access.

BLE access is provided by [`@stoprocent/noble`](https://www.npmjs.com/package/@stoprocent/noble),
including its prebuilt Linux ARMv6 binding for the Raspberry Pi Zero W.

## Supported environment

- Homebridge 1.8.5
- Node.js 20.18.0
- Raspberry Pi OS Bookworm
- Raspberry Pi Zero W built-in Bluetooth adapter
- Govee H61E0

## Raspberry Pi setup

Install the Bluetooth packages:

```sh
sudo apt update
sudo apt install --no-install-recommends bluetooth bluez libbluetooth-dev libudev-dev
```

Allow the Node.js binary used by Homebridge to open the raw Bluetooth socket:

```sh
sudo setcap cap_net_raw+eip "$(readlink -f "$(command -v node)")"
```

Restart Homebridge after setting the capability. Reapply it after replacing or
upgrading the Node.js binary.

Find the strip's BLE address while the Govee app is disconnected:

```sh
bluetoothctl scan on
```

Look for a device named like `Govee_H61E0_XXXX`. Copy its colon-separated BLE
address, then stop the scan with `bluetoothctl scan off`.

The Govee app must not be connected to the strip while Homebridge sends a
command. BLE supports only one active connection to this device.

## Install

From this project directory:

```sh
npm install
npm run build
sudo npm link
```

For a standard Homebridge service install, link the plugin from the same Node.js
installation that runs Homebridge.

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

`hciDeviceId` corresponds to `hci0`, `hci1`, and so on. The plugin never changes
the system's selected Bluetooth adapter.

## Behavior and limitations

- BLE operations are serialized so simultaneous HomeKit changes cannot compete
  for the Raspberry Pi's single adapter.
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

- `Bluetooth adapter is unauthorized`: verify `getcap "$(command -v node)"`
- `Bluetooth adapter is poweredOff`: run `sudo rfkill unblock bluetooth`
- `could not find Govee strip`: verify the address and close the Govee app
- native module installation failure: ensure `build-essential`, `python3`,
  `libbluetooth-dev`, and `libudev-dev` are installed

## Protocol

Commands are 20 bytes: `0x33`, command, payload, zero padding, and an XOR of the
first 19 bytes. H61E0 uses service UUID
`00010203-0405-0607-0809-0a0b0c0d1910` and write characteristic UUID
`00010203-0405-0607-0809-0a0b0c0d2b11`.
