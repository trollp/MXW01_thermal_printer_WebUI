# MXW01 thermal printer — web UI, CLI and API for Linux

Print text, images and QR codes to the **MXW01** Bluetooth thermal printer (the
57 mm "cat printer" sold under many names) from a Linux machine — through a
browser, from the command line, or from any script via a small JSON API.

Built on [clementvp/mxw01-thermal-printer](https://github.com/clementvp/mxw01-thermal-printer),
which implements the printer protocol and the dithering; this repo adds
everything around it. It also documents a **BlueZ quirk that stops the MXW01
from connecting at all on most Linux desktops**, and the fix
([docs/BLUETOOTH.md](docs/BLUETOOTH.md)).

## Features

* **Web UI** — text with simple markup, drag‑and‑drop / paste images, QR codes
  with captions, paper feed, printer status, and a live **preview of the exact
  1‑bit bitmap** that will be printed. Light/dark theme, works on a phone.
* **`mxprint` CLI** — `mxprint image photo.jpg`, `mxprint text "…"`,
  `fortune | mxprint text`, `mxprint qr URL`, `--preview out.png` to check
  without paper.
* **Charts and weather forecasts** — `chart` and `forecast` job types render
  line charts (time series with axes, grid, min/max) and daily forecasts with
  vector weather icons, designed for 1‑bit paper. Feed them data from your
  home‑automation system, a script, anything.
* **JSON API** — `POST /api/print` from anything (cron jobs, home automation,
  CI…).
* **Configurable defaults** — dithering algorithm, brightness, print‑head
  intensity, fonts, margins, connection behaviour; saved in `settings.json`,
  editable in the UI.
* **Connection management** — the server keeps the BLE link between jobs so
  consecutive prints are instant, and releases it after an idle period so the
  phone app can take over.
* **No root, no `setcap`** — uses BlueZ over D‑Bus.
* No framework, no build step: Node's `http` module and one HTML file.

## Requirements

* Linux with **BlueZ ≥ 5.72**. On 5.79+ (Fedora 40+, Ubuntu 24.10+, Debian 13,
  Arch…) a one‑time `PreferredBearer` setting makes the printer connectable
  for everything; on older BlueZ (Ubuntu 24.04 = 5.72) you configure the
  printer's address instead and this project handles the connection itself.
  Both are below.
* **Node.js ≥ 18**.
* Build tools and libraries for `node-canvas` if no prebuilt binary matches
  your platform: on Fedora `gcc-c++ make python3 cairo-devel pango-devel
  libjpeg-turbo-devel giflib-devel librsvg2-devel`; on Debian/Ubuntu
  `build-essential python3 libcairo2-dev libpango1.0-dev libjpeg-dev
  libgif-dev librsvg2-dev`.
* Fonts: anything fontconfig knows. Defaults are *Liberation Sans* /
  *Liberation Mono* (`fonts-liberation` / `liberation-fonts`).

## Install

```sh
git clone https://github.com/trollp/MXW01_thermal_printer_WebUI.git
cd MXW01_thermal_printer_WebUI
npm install

# optional: put the commands on your PATH
ln -s "$PWD/mxprint" "$PWD/mxprint-web" ~/.local/bin/
```

### Bluetooth setup (required, once)

The MXW01 advertises that it supports classic Bluetooth, but it doesn't, so
BlueZ tries the wrong bearer and every connection times out. Tell BlueZ to use
LE for this device:

```sh
sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf
sudo systemctl restart bluetooth

bluetoothctl --timeout 10 scan le >/dev/null
bluetoothctl devices | grep MXW01            # → Device AA:BB:CC:DD:EE:FF MXW01

D=/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF       # your printer's address, ':' → '_'
gdbus call --system --dest org.bluez --object-path $D --method org.freedesktop.DBus.Properties.Set org.bluez.Device1 PreferredBearer '<"le">'
gdbus call --system --dest org.bluez --object-path $D --method org.freedesktop.DBus.Properties.Set org.bluez.Device1 Trusted '<true>'
```

**BlueZ older than 5.79** (`bluetoothctl --version`; e.g. Ubuntu 24.04) has no
`PreferredBearer`. Do only the first two lines above (Experimental + restart),
then give this project the printer's address so it can ask BlueZ for an LE
connection directly:

```sh
cp settings.example.json settings.json
#   → set "bluetooth": { "address": "AA:BB:CC:DD:EE:FF" }   (or in the UI: Settings → Printer Bluetooth address)
./mxprint --address AA:BB:CC:DD:EE:FF status              # one-off from the CLI
```

Details, diagnosis and other pitfalls: [docs/BLUETOOTH.md](docs/BLUETOOTH.md).

### First print

```sh
./mxprint status
./mxprint text "# Hello" "from Linux"
```

## Web UI

```sh
./mxprint-web                 # http://localhost:8377
./mxprint-web --host 0.0.0.0  # reachable from other devices on your network (no auth!)
```

| Tab | What you get |
|---|---|
| **Text** | Textarea with `# heading`, `## sub‑heading`, `---` rule, blank line = paragraph gap. Font (any system font), size, alignment, margin, line height, bold, monospace. |
| **Image** | Drop, pick or paste images; several print as one strip; scale‑to‑width or keep pixels. |
| **QR code** | Text/URL, size, optional caption. |
| **Printer** | Live connection state, battery %, print‑head temperature, firmware version, paper / cover / jam flags, feed paper, and a *dither test strip* that prints a gradient in every mode for comparison. |
| **Settings** | All defaults below, plus idle‑disconnect and scan timeout. |

Every print tab has a collapsible *Print options* block (dither, rotate, flip,
brightness, intensity, invert), and the preview on the right is re‑rendered as
you type — it is the real dithered bitmap, not the source image.

To run it as a service that starts with your session:

```sh
mkdir -p ~/.config/systemd/user
sed "s|__DIR__|$PWD|" systemd/mxprint-web.service > ~/.config/systemd/user/mxprint-web.service
systemctl --user daemon-reload && systemctl --user enable --now mxprint-web
journalctl --user -u mxprint-web -f          # logs
```

## CLI

```
mxprint image <file...>        print image file(s) (png/jpg/gif/svg), scaled to paper width
mxprint text [text...]         print text; reads stdin when no text given or text is "-"
mxprint qr <text> [--label L]  print a QR code, optionally with a caption
mxprint feed [px]              feed blank paper (8 px ≈ 1 mm)
mxprint status                 show printer status
mxprint job <file.json|->      print any job object from JSON (chart, forecast, text, …)
mxprint web [--host H] [--port P]
```

Options on every print command:

| Option | Default | |
|---|---|---|
| `--dither` | image `steinberg`, text/qr `threshold` | `threshold` `steinberg` `bayer` `atkinson` `pattern` |
| `--style` (text) | | any style name from the font table below (`display`, `elegant`, `handwriting`, …) |
| `--brightness` | 128 | 0–255, applied before dithering; higher = lighter |
| `--intensity` | 93 (qr 110) | 0–255 print‑head heat; 150+ can damage paper |
| `--rotate` / `--flip` | 0 / none | `0 90 180 270` / `none h v both` |
| `--invert` | | white on black |
| `--preview FILE` | | write a PNG of exactly what would print, don't print |
| `--timeout S` | 30 | scan timeout |
| `--address MAC` | from settings | printer address; BlueZ connects over LE first (BlueZ < 5.79) |

Text: `--size`, `--font`, `--mono`, `--bold`, `--align left|center|right`,
`--margin`, `--line-height`. Image: `--no-scale`, `--gap`. QR: `--size`,
`--label`.

```sh
mxprint image ~/Pictures/cat.jpg --dither atkinson --brightness 140
mxprint text "# Shopping" "milk" "eggs" "---" "$(date +%F)"
fortune | mxprint text --mono --size 18
mxprint qr "https://example.com" --label "scan me"
mxprint text "# Draft" "check layout first" --preview /tmp/out.png
```

## API

Same origin as the UI. Jobs are JSON; unspecified fields use the saved
defaults.

```sh
curl -s -X POST localhost:8377/api/print -H 'Content-Type: application/json' \
  -d '{"type":"text","text":"# Build passed\n'"$(date)"'","align":"center"}'
```

| Endpoint | |
|---|---|
| `POST /api/print` | job → `{ok, height, state}` when the printer reports completion; with `"async": true` (or `?async=1`) → `202 {ok, queued, printerOnline, willPrintWhenOnline, height}` as soon as the job is rendered and queued. With keep‑alive on, a job sent while the printer is off is **parked and printed when the printer comes back** (up to 25 jobs, 12 h) |
| `POST /api/preview` | job → `image/png` of the dithered bitmap, header `X-Height` |
| `POST /api/status` | `{state: {printing, paper_jam, out_of_paper, cover_open, battery_low, overheat, battery, temperatureC, firmware}, text}` |
| `POST /api/connect`, `POST /api/disconnect` | hold / release the BLE link |
| `GET /api/state` | manager snapshot; `GET /api/events` streams it (SSE) |
| `GET /api/settings`, `PUT /api/settings` | read / save defaults |

Job fields:

```jsonc
{ "type": "text" | "image" | "qr" | "feed" | "test",
  "dither": "steinberg", "brightness": 128, "intensity": 93, "rotate": 0, "flip": "none", "invert": false,
  "text": "…", "size": 26, "font": "Liberation Sans", "mono": false, "bold": false,
  "align": "left", "margin": 10, "lineHeight": 1.25,                       // text
  "images": ["data:image/png;base64,…", "https://host/pic.jpg"], "gap": 24, "noScale": false,   // image: data URLs or http(s) URLs
  "label": "caption", "labelSize": 22,                                     // qr (size = code size)
  "px": 120 }                                                              // feed
```

### Charts

```jsonc
{ "type": "chart",
  "title": "Living room temperature", "subtitle": "last 24 h", "unit": "°C",
  "series": [
    { "label": "Living room", "points": [["2026-09-18T00:00:00Z", 21.4], ["2026-09-18T00:05:00Z", 21.5], null] },
    { "label": "Outside",     "points": [[1758153600000, 11.2], [1758157200000, 10.9]] }   // up to 3 series
  ],
  "height": 220, "yMin": 15, "yMax": 25, "decimals": 1, "stats": true }
```

Points are `[time, value]` with time as ISO string or ms epoch (or plain
numbers with `"timeAxis": false`); `null` values break the line. Ticks are
chosen automatically (hours / 12 h / days), the first series gets min/max
markers and a `min · max · last` line. Second and third series are dashed and
dotted. Large series are downsampled to ~800 points.

### Checklists

```jsonc
{ "type": "checklist", "title": "Shopping list", "date": "Sat 20 Sep",
  "items": ["Milk", { "text": "Coffee beans", "note": "due Sun" }, { "text": "Butter", "done": true }],
  "size": 24, "showDone": true, "footer": "auto: '4 open · 1 done'", "emptyText": "(nothing on the list)" }
```

☐ boxes (ticked and struck through when `done`), wrapped long items, optional
note line per item, counts in the footer.

### Labels

```jsonc
{ "type": "label", "text": "Chicken soup", "sub": "2 portions · reheat 8 min", "date": true,
  "icon": "snowflake", "band": "FREEZER", "font": "display", "frame": "rounded",
  "qr": "https://…", "note": "use within 3 months", "count": 3,
  "details": ["Grape: Red · Cyprus", "400 ml · 12 % vol."] }   // small lines inside the frame
```

Auto‑fitted title (one line when it can stay ≥ 40 px), optional second line,
date/note line, inverted header band, vector icon (`jar snowflake leaf bottle
bread fish meat cheese cup heart star gift sun clock warning`), QR on the
right, frames `rounded | double | ticket | none`, several copies separated by
`✂` cut lines. Fonts are bundled in `fonts/` (OFL / Apache licences included)
and addressed by style name:

| Group | Styles |
|---|---|
| plain | `sans` `serif` `mono` (Liberation) |
| professional | `modern` / `clean` (Poppins), `classic` (Libre Baskerville), `garamond` (EB Garamond), `elegant` (Playfair Display), `roman` (Cinzel, caps) |
| display & creative | `display` (Bebas Neue), `impact` (Anton), `slab` (Alfa Slab One), `fatface` (Abril Fatface), `vintage` (Yeseva One), `retro` (Righteous), `comic` (Bangers), `western` (Rye), `typewriter` (Special Elite) |
| handwriting & script | `marker`, `handwriting` (Kalam Bold), `casual` (Patrick Hand), `script` (Pacifico), `lobster` |

`mxprint job` with `{"type":"fontsheet"}` prints a specimen of all of them.

Text jobs accept the same `style` names plus `frame` (`rounded | double |
dashed`) and `ruled: true` for notepad lines:

```jsonc
{ "type": "text", "style": "handwriting", "ruled": true, "frame": "rounded",
  "text": "Anna,\ndinner is in the fridge.\n\n— Peter" }
```

### Weather forecast

```jsonc
{ "type": "forecast",
  "title": "Weather · Stockholm", "unit": "°",
  "now":  { "temperature": 11.5, "condition": "clear-night", "text": "clear night, 84 % humidity" },
  "days": [
    { "date": "2026-09-19", "condition": "partlycloudy", "high": 17.0, "low": 11.4, "precipitation": 0,   "wind": 9.5 },
    { "date": "2026-09-20", "condition": "rainy",        "high": 16.2, "low": 10.1, "precipitation": 4.2, "wind": 7,
      "precipitationProbability": 80, "label": "Tomorrow" }
  ],
  "maxDays": 7 }
```

One row per day: weekday, icon, low–high range bar on a shared scale,
precipitation (mm, optional probability) and wind, plus a small
precipitation bar. Wind is printed in m/s; give `"windUnit": "kn"|"km/h"|"mph"`
(job‑level or per day) when the source uses another unit. Conditions use the
Home‑Assistant/Weather‑Kit vocabulary:
`sunny clear-night partlycloudy cloudy rainy pouring snowy snowy-rainy hail
lightning lightning-rainy fog windy windy-variant exceptional`. `datetime`, `temperature`,
`templow`, `wind_speed`, `precipitation_probability` are accepted as aliases,
so raw forecast entries can be passed through unchanged; `now` likewise takes
`humidity`, `wind`/`wind_speed` and builds the description itself.

Try both with `mxprint job file.json --preview out.png`.

Requests are queued and run one at a time. Errors come back as
`{"error": "…"}` with status 400/404/413/500.

## Settings

`settings.json` in the repo directory (see [`settings.example.json`](settings.example.json));
created by *Save* in the UI, or copy the example. Sections: `server` (host,
port, `idleDisconnectSec` — 0 releases the printer after every job —,
`scanTimeoutSec`), `bluetooth` (`address` of the printer and `adapter`; see
Bluetooth setup), `print` (global defaults), `image`, `text`, `qr`, `feed`
(per‑type overrides). The CLI reads the same file.

## How it works

```
CLI ──┐                                   ┌─ lib/render.cjs   text/image/QR → 384 px canvas
      ├─ job {type, …} ─▶ renderJob ──────┤
UI ─▶ server.cjs (http + SSE) ────────────┴─ lib/printer.cjs  queue, connect, idle release
                                                  │
                                    mxw01-thermal-printer  dither → 1‑bit rows → BLE packets
                                                  │
                          @stoprocent/noble (dbus binding) → BlueZ → printer
```

* `lib/render.cjs` — all drawing (node‑canvas). `ditheredPreview()` runs the
  library's own pipeline and paints the resulting rows, so previews are
  pixel‑identical to prints.
* `lib/labels.cjs` — labels: frames, header bands, vector icons, auto‑fit
  type, cut lines. `lib/fonts.cjs` registers the bundled fonts and defines the
  named styles.
* `lib/charts.cjs` — line charts and forecast rows with hand‑drawn weather
  icons; only solid ≥2 px strokes and dotted grids, so nothing is lost to
  thresholding.
* `lib/printer.cjs` — `PrinterManager`: serialises jobs, connects on demand
  with a scan timeout, releases the link after `idleDisconnectSec`. With a
  configured address it first calls BlueZ's `Adapter1.ConnectDevice` over
  D‑Bus (always LE) and waits for `ServicesResolved` before handing over to
  noble. It also watches for links the printer drops on its own (the
  library's adapter does not) and re‑runs a job once on a dead link;
  connects are retried once, since the MXW01 sometimes pauses advertising for
  a few seconds after a burst of jobs.
* `lib/settings.cjs` — defaults, load/save.
* `server.cjs` — routes, base64 image upload (no multipart), font list from
  `fc-list`, server‑sent events.
* `web/index.html` — the UI, vanilla JS, no build.
* `mxprint` / `mxprint-web` — launchers that set `NOBLE_BINDINGS=dbus`
  (see docs/BLUETOOTH.md) and run the `.cjs` entry points.

The printer is 384 dots wide at 203 dpi (48 mm printable). Everything is
rendered onto a 384‑px‑wide canvas, dithered to 1 bit, and streamed as 48‑byte
rows.

Besides the library's commands, `PrinterManager` sends `0xAB` (battery level,
one byte = %), `0xB1` (firmware version string) and reads byte 4 of the `0xA1`
status payload as the head temperature in °C (observed on firmware 1.9.3.1.2;
protocol notes from [dropalltables/catprinter](https://github.com/dropalltables/catprinter/blob/main/PROTOCOL.md)).

### Notes on `package.json`

Two `overrides` are needed for a clean install and are easy to trip over if
you copy the dependencies elsewhere:

* `mxw01-thermal-printer` declares its optional peer `@stoprocent/noble` as
  `^1.x`, but the BlueZ D‑Bus binding only exists in noble 2.x. The override
  points the peer at our copy.
* `dbus-next` has an optional dependency (`usocket`) that pulls in
  `node-gyp@7`, which cannot build on Node ≥ 20 and breaks noble's native build
  when it gets hoisted. `node-gyp` is overridden to a current version.
* `patches/dbus-next+0.10.2.patch` (applied by `patch-package` on
  `npm install`) fixes a refcount bug in `dbus-next`: the `hasOwnProperty`
  arguments in `_addMatch`/`_removeMatch` are swapped, so D‑Bus match rules
  were added on every subscription and never removed. With the printer off
  for a few hours the server hit `max_match_rules_per_connection=2048` and
  crashed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `printer not found within 30s` | Printer off (auto‑off after idle) or connected to the phone app. |
| Found but connect times out / `disconnected: removed` | Bluetooth setup above not applied; `bluetoothctl info <addr>` must show `Trusted: yes` and `PreferredBearer: le`. |
| `Failed to set power on` | `rfkill unblock bluetooth` |
| `Noble is not installed` | Run through `./mxprint` / `./mxprint-web`, not `node mxprint.cjs`. |
| `characteristic not found`, `br-connection-busy`, `Print timeout` once in a while | The printer dropped or refused the link; the server reconnects and retries automatically (a print timeout is not retried, the page may have printed). If it persists, power‑cycle the printer. |
| Too dark / bleeding | Lower `--intensity` (≈80) or raise `--brightness`. |
| Too light | Raise `--intensity` (100–120). |
| `canvas` fails to install | Install the native libraries listed under Requirements, then `npm rebuild canvas`. |

More in [docs/BLUETOOTH.md](docs/BLUETOOTH.md).

## Credits

* [clementvp/mxw01-thermal-printer](https://github.com/clementvp/mxw01-thermal-printer) — protocol, dithering, Node adapter (MIT).
* [dropalltables/catprinter](https://github.com/dropalltables/catprinter) and
  [rbaron/catprinter](https://github.com/rbaron/catprinter) — the reverse engineering the library builds on.
* [@stoprocent/noble](https://github.com/stoprocent/noble) — BLE for Node, including the BlueZ D‑Bus binding.

## License

MIT — see [LICENSE](LICENSE).
