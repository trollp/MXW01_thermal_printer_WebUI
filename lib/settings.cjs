// Persisted defaults for the web UI and CLI (settings.json in the project directory).

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "settings.json");

const DEFAULTS = {
  // keepAlive: hold the BLE link permanently and poll the printer every
  // keepAliveIntervalSec (keeps it from auto-powering-off, instant prints,
  // but the phone app can never connect while the server runs).
  server: { host: "127.0.0.1", port: 8377, idleDisconnectSec: 120, scanTimeoutSec: 30, keepAlive: false, keepAliveIntervalSec: 60 },
  // address: the printer's Bluetooth address (AA:BB:CC:DD:EE:FF). When set, the
  // server asks BlueZ for an LE connection to it before scanning, which is what
  // makes the MXW01 connectable on BlueZ < 5.79 (docs/BLUETOOTH.md).
  bluetooth: { address: "", adapter: "hci0" },
  print: { dither: "steinberg", brightness: 128, intensity: 93, rotate: 0, flip: "none" },
  image: { dither: "steinberg", brightness: 128, intensity: 93, noScale: false, gap: 24 },
  text: { dither: "threshold", intensity: 93, size: 26, font: "Liberation Sans", mono: false, bold: false, align: "left", margin: 10, lineHeight: 1.25 },
  qr: { intensity: 110, size: 300, labelSize: 22 },
  feed: { px: 120 },
  chart: { dither: "threshold", intensity: 100 },
  forecast: { dither: "threshold", intensity: 100 },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? deepMerge(base[k], v) : v;
  }
  return out;
}

function load() {
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    return deepMerge(DEFAULTS, {});
  }
}

function save(settings) {
  const merged = deepMerge(DEFAULTS, settings);
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

module.exports = { DEFAULTS, FILE, load, save, deepMerge };
