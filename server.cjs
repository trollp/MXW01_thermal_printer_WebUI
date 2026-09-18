#!/usr/bin/env node
// Web UI + JSON API for the MXW01 printer. No dependencies beyond the CLI's.
//   mxprint web [--host 0.0.0.0] [--port 8377]

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const R = require("./lib/render.cjs");
const { PrinterManager, describeState } = require("./lib/printer.cjs");
const Settings = require("./lib/settings.cjs");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("mxprint web [--host <addr>] [--port <n>]\n  defaults come from settings.json (server section)\n  use --host 0.0.0.0 to reach the UI from other devices on your network");
  process.exit(0);
}
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

let settings = Settings.load();
const HOST = arg("--host") || settings.server.host;
const PORT = Number(arg("--port") || settings.server.port);
const MAX_BODY = 40 * 1024 * 1024;
const WEB_DIR = path.join(__dirname, "web");

const log = (m) => console.log(new Date().toLocaleTimeString() + "  " + m);
const pm = new PrinterManager({
  idleDisconnectSec: settings.server.idleDisconnectSec,
  scanTimeoutSec: settings.server.scanTimeoutSec,
  address: settings.bluetooth.address,
  adapter: settings.bluetooth.adapter,
  keepAlive: settings.server.keepAlive,
  keepAliveIntervalSec: settings.server.keepAliveIntervalSec,
  log,
});
if (settings.server.keepAlive) pm.setKeepAlive(true);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON body"); }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** An image given as a data URL, raw base64, or an http(s) URL the server fetches (handy for automations). */
async function imageToBuffer(src) {
  if (typeof src !== "string") throw new HttpError(400, "image must be a data URL or an http(s) URL");
  if (/^https?:\/\//i.test(src)) {
    let res;
    try {
      res = await fetch(src, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    } catch (err) {
      throw new HttpError(400, `cannot fetch ${src}: ${err.message}`);
    }
    if (!res.ok) throw new HttpError(400, `cannot fetch ${src}: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) throw new HttpError(413, "image too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image too large");
    return buf;
  }
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(src);
  return Buffer.from(m ? m[1] : src, "base64");
}

/** Turn a UI/API job description into a render job + print options, applying saved defaults. */
async function buildJob(body) {
  const type = body.type;
  const sectionDefaults = { ...settings.print, ...(settings[type] || {}) };
  const job = { ...sectionDefaults, ...body, type };
  if (type === "image") {
    const list = [].concat(body.images || [], body.imageUrls || [], body.image || []);
    job.images = await Promise.all(list.map(imageToBuffer));
  }
  if (type === "qr") job.dither = "threshold";
  if (type === "feed") job.dither = "threshold";
  const popts = R.printOptions(job, sectionDefaults);
  return { job, popts };
}

function listFonts() {
  return new Promise((resolve) => {
    execFile("fc-list", [":", "family"], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(["Liberation Sans", "Liberation Mono", "Liberation Serif"]);
      const fams = new Set();
      for (const line of out.split("\n")) {
        const fam = line.split(",")[0].trim();
        if (fam && !/^Noto (Sans|Serif) [A-Z]/.test(fam)) fams.add(fam); // skip the hundreds of Noto script variants
      }
      resolve([...fams].sort((a, b) => a.localeCompare(b)));
    });
  });
}

// ---------------------------------------------------------------------------
// live state via server-sent events
// ---------------------------------------------------------------------------
const sseClients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(pm.snapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}
pm.on("change", broadcast);

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const route = req.method + " " + url.pathname;

  if (route === "GET /" || route === "GET /index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(WEB_DIR, "index.html")));
    return;
  }

  if (route === "GET /api/state") return sendJson(res, 200, pm.snapshot());

  if (route === "GET /api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(pm.snapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (route === "GET /api/settings") {
    return sendJson(res, 200, { settings, defaults: Settings.DEFAULTS, fonts: await listFonts(), dithers: R.DITHERS, width: R.WIDTH });
  }

  if (route === "PUT /api/settings") {
    const body = await readJson(req);
    settings = Settings.save(body);
    pm.idleDisconnectSec = settings.server.idleDisconnectSec;
    pm.scanTimeoutSec = settings.server.scanTimeoutSec;
    pm.address = settings.bluetooth.address;
    pm.adapter = settings.bluetooth.adapter;
    pm.setKeepAlive(settings.server.keepAlive, settings.server.keepAliveIntervalSec);
    log("settings saved");
    return sendJson(res, 200, { settings });
  }

  if (route === "POST /api/preview") {
    const { job, popts } = await buildJob(await readJson(req));
    const canvas = R.ditheredPreview(await R.renderJob(job), popts);
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Height": String(canvas.height) });
    res.end(canvas.toBuffer("image/png"));
    return;
  }

  if (route === "POST /api/print") {
    const body = await readJson(req);
    const { job, popts } = await buildJob(body);
    const canvas = await R.renderJob(job);
    log(`print ${job.type} ${canvas.height}px (${popts.dither}, intensity ${popts.intensity})`);
    const printing = pm.print(R.canvasImageData(canvas), popts, job.type);
    // async: answer as soon as the job is rendered and queued (voice assistants,
    // automations that should not block); failures then only show in the log/UI.
    if (body.async === true || url.searchParams.get("async") === "1") {
      printing.catch((err) => log(`async print failed: ${err.message}`));
      return sendJson(res, 202, { ok: true, queued: true, height: canvas.height, state: pm.snapshot() });
    }
    await printing;
    return sendJson(res, 200, { ok: true, height: canvas.height, state: pm.snapshot() });
  }

  if (route === "POST /api/status") {
    const state = await pm.status();
    return sendJson(res, 200, { state, text: describeState(state), manager: pm.snapshot() });
    // state also carries battery (%), temperatureC and firmware
  }

  if (route === "POST /api/connect") { await pm.connect(); return sendJson(res, 200, pm.snapshot()); }
  if (route === "POST /api/disconnect") { await pm.disconnect(); return sendJson(res, 200, pm.snapshot()); }

  throw new HttpError(404, "not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : err instanceof R.OptionError ? 400 : 500;
    if (status >= 500) log("error: " + (err.stack || err.message));
    if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`MXW01 web UI on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}${HOST === "0.0.0.0" ? "  (reachable from your network)" : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { await pm.disconnect(); process.exit(0); });
}
