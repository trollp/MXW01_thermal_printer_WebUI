# Getting the MXW01 to connect on Linux (BlueZ)

If the printer shows up in scans but **every connection attempt times out**,
this page is for you. It documents a firmware quirk of the MXW01 and the
three‑line BlueZ fix.

## Symptoms

* `bluetoothctl devices` lists `MXW01` with a good RSSI.
* `mxprint status` fails with `printer not found` or
  `Failed to connect to device: disconnected: removed`.
* Connecting directly through BlueZ also fails:
  `gdbus call … org.bluez.Device1.Connect` → `Error: Timeout was reached`.
* The GNOME/KDE Bluetooth panel says it cannot connect.
* `journalctl -u bluetooth` shows only `No matching connection for device`.
* Other BLE devices connect fine.

## Cause

A kernel‑level trace (`sudo btmon`) during a connect attempt shows BlueZ
sending a **classic Bluetooth `Create Connection`** (BR/EDR paging) rather than
an `LE Create Connection`, which fails after ~8 s with `Page Timeout`.

The printer's BLE advertisement carries `Flags: 0x0A`:

```
LE General Discoverable Mode
Simultaneous LE and BR/EDR (Controller)
```

The "BR/EDR Not Supported" bit is missing, so BlueZ treats the device as
dual‑mode and prefers the classic bearer for `Connect()`. The printer does not
actually answer on classic Bluetooth. The firmware is lying about its
capabilities; nothing on the PC side is broken.

## Fix (BlueZ ≥ 5.79)

BlueZ ≥ 5.79 can be told which bearer to use per device, but only when its
experimental D‑Bus interfaces are enabled.

```sh
# 1. Enable experimental D-Bus interfaces (exposes PreferredBearer / Bearer.LE1)
sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth

# 2. Find the printer's address
bluetoothctl --timeout 10 scan le >/dev/null
bluetoothctl devices | grep MXW01          # e.g. Device AA:BB:CC:DD:EE:FF MXW01

# 3. Prefer LE for this device, and make the entry permanent
D=/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF    # your address, colons -> underscores
gdbus call --system --dest org.bluez --object-path $D \
  --method org.freedesktop.DBus.Properties.Set org.bluez.Device1 PreferredBearer '<"le">'
gdbus call --system --dest org.bluez --object-path $D \
  --method org.freedesktop.DBus.Properties.Set org.bluez.Device1 Trusted '<true>'
```

Why `Trusted`: unpaired devices are "temporary" in BlueZ and get purged from
the cache soon after a scan ends, taking the `PreferredBearer` setting with
them. Trusting the device makes it permanent (stored under
`/var/lib/bluetooth/`). Side effect: BlueZ will auto‑connect to the printer
over LE whenever it sees it advertising, which is harmless.

Verify:

```sh
bluetoothctl info AA:BB:CC:DD:EE:FF
#   Trusted: yes
#   PreferredBearer: le
```

If `PreferredBearer` is not listed at all, the experimental flag is not active
(check `grep ^Experimental /etc/bluetooth/main.conf` and that `bluetoothd` was
restarted).

## Fix (BlueZ 5.72 – 5.78, e.g. Ubuntu 24.04)

Older BlueZ has no `PreferredBearer`, but it does have the experimental
`org.bluez.Adapter1.ConnectDevice` method, which connects to a given address
**over LE unconditionally**:

```sh
sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth

gdbus call --system --dest org.bluez --object-path /org/bluez/hci0 \
  --method org.bluez.Adapter1.ConnectDevice \
  '{"Address": <"AA:BB:CC:DD:EE:FF">, "AddressType": <"public">}'
```

This project does exactly that call before every connection when
`bluetooth.address` is set in `settings.json` (or `--address` on the CLI).
Once BlueZ has completed one LE connection it also tends to pick LE for plain
`Connect()` for a while, but the explicit call makes it deterministic.

If `ConnectDevice` itself times out, power‑cycle the printer: it may still be
holding a link with another device.

## Other pitfalls

| Problem | Fix |
|---|---|
| `Failed to set power on: org.bluez.Error.Failed` | Adapter is rfkill‑blocked: `rfkill unblock bluetooth && bluetoothctl power on` |
| Printer visible but never connectable, even after the fix | The phone app is connected to it. The MXW01 accepts one central at a time and keeps advertising while connected. Close the app / turn the phone's Bluetooth off. |
| Worked once, then `printer not found` | The printer powers itself off after a few idle minutes. |
| Bluetooth panel "pairing failed" | Expected. The printer has no pairable profile; this project connects over GATT without pairing. |

## Why this project uses noble's D‑Bus binding

`@stoprocent/noble` on Linux defaults to raw HCI sockets, which needs root or
`setcap cap_net_raw+eip $(which node)` (lost on every Node upgrade) and
competes with `bluetoothd` for the adapter. Noble 2.x also has a BlueZ D‑Bus
binding (`NOBLE_BINDINGS=dbus`, needs the `dbus-next` package) that needs no
privileges and coexists with the desktop stack. The launchers in this repo set
that variable. The price is that BlueZ decides how to connect — hence the
bearer fix above.

## Diagnosing yourself

```sh
sudo btmon                                   # terminal 1: live HCI trace
gdbus call --system --dest org.bluez --object-path $D --method org.bluez.Device1.Connect   # terminal 2
```

Look for `LE Create Connection` (good) vs `Create Connection` (classic —
bearer problem), and for the status in the following `Connect Complete` /
`LE Enhanced Connection Complete` event.
