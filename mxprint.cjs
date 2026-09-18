#!/usr/bin/env node
// mxprint - CLI for the MXW01 thermal printer (rendering lives in lib/render.cjs)

const fs = require("fs");
const R = require("./lib/render.cjs");
const { PrinterManager, describeState } = require("./lib/printer.cjs");
const settings = require("./lib/settings.cjs").load();

const HELP = `mxprint - print to the MXW01 thermal printer

Usage:
  mxprint image <file...>        print image file(s) (png/jpg/gif/svg), scaled to paper width
  mxprint text [text...]         print text; reads stdin when no text given or text is "-"
  mxprint qr <text> [--label L]  print a QR code, optionally with a caption
  mxprint feed [px]              feed blank paper (default ${settings.feed.px}px)
  mxprint status                 show printer status
  mxprint web                    start the web UI (see mxprint web --help)
  mxprint help

Print options (all commands):
  --dither <m>        ${R.DITHERS.join("|")}  (image default: ${settings.image.dither}, text: ${settings.text.dither})
  --brightness <n>    0-255, default ${settings.print.brightness} (lower = darker)
  --intensity <n>     0-255 print head heat, default ${settings.print.intensity} (qr: ${settings.qr.intensity})
  --rotate <deg>      0|90|180|270
  --flip <f>          none|h|v|both
  --invert            invert black/white before printing
  --preview <file>    write a PNG of exactly what would print, instead of printing
  --timeout <s>       scan timeout in seconds (default ${settings.server.scanTimeoutSec})
  --address <mac>     printer address; makes BlueZ connect over LE first (needed on BlueZ < 5.79)

Image options:
  --no-scale          do not scale to paper width (crops if wider)
  --gap <px>          blank space between multiple images (default ${settings.image.gap})

Text options:
  --size <px>         font size, default ${settings.text.size}
  --font <name>       font family, default "${settings.text.font}"
  --mono              use Liberation Mono
  --bold              bold text
  --align <a>         left|center|right
  --margin <px>       side margin, default ${settings.text.margin}
  --line-height <f>   line height factor, default ${settings.text.lineHeight}
  Light markup: "# " big heading, "## " heading, "---" horizontal rule, blank line = paragraph gap.

QR options:
  --size <px>         QR size, default ${settings.qr.size}
  --label <text>      caption under the code

Defaults are read from settings.json in the project directory (edit it or use the web UI's Settings tab).

Examples:
  mxprint image photo.jpg --dither atkinson
  mxprint text "Hello there"
  echo "shopping list" | mxprint text --mono
  mxprint qr https://example.com --label "scan me"
  mxprint text "# Title" "some body text" --preview out.png
`;

const FLAGS_WITH_VALUE = new Set([
  "dither", "brightness", "intensity", "rotate", "flip", "preview", "timeout",
  "gap", "size", "font", "align", "margin", "line-height", "label", "address",
]);
const BOOL_FLAGS = new Set(["invert", "no-scale", "mono", "bold", "help"]);

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a === "-h") { opts.help = true; continue; }
    if (!a.startsWith("--") || /^-+$/.test(a)) { positional.push(a); continue; }
    let [key, val] = a.slice(2).split(/=(.*)/s);
    if (BOOL_FLAGS.has(key)) { opts[key] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(key)) die(`Unknown option --${key}\n\n${HELP}`);
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) die(`--${key} needs a value`);
    }
    opts[key] = val;
  }
  // camelCase the renderer options
  if ("line-height" in opts) opts.lineHeight = opts["line-height"];
  if ("no-scale" in opts) opts.noScale = true;
  return { opts, positional };
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function manager(opts) {
  const scanTimeoutSec = Number(opts.timeout) || settings.server.scanTimeoutSec;
  return new PrinterManager({
    idleDisconnectSec: 0, scanTimeoutSec, log: (m) => console.error(m),
    address: opts.address ?? settings.bluetooth.address, adapter: settings.bluetooth.adapter,
  });
}

/** Render a job, then either write the preview PNG or print it. */
async function output(job, opts, popts) {
  const canvas = await R.renderJob(job);
  if (opts.preview) {
    const preview = R.ditheredPreview(canvas, popts);
    fs.writeFileSync(opts.preview, preview.toBuffer("image/png"));
    console.error(`Preview written to ${opts.preview} (${preview.width}x${preview.height})`);
    return;
  }
  const pm = manager(opts);
  console.error("Looking for MXW01...");
  console.error(`Printing ${canvas.height}px (${popts.dither}, intensity ${popts.intensity})...`);
  await pm.print(R.canvasImageData(canvas), popts, job.type);
  console.error("Done.");
  await pm.disconnect();
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift();
  if (!cmd || cmd === "help" || (opts.help && cmd !== "web")) { console.log(HELP); return; }

  switch (cmd) {
    case "image": {
      if (!positional.length) die("image: give at least one file");
      const d = { ...settings.print, ...settings.image };
      const job = { type: "image", images: positional, ...d, ...opts };
      await output(job, opts, R.printOptions(opts, d));
      break;
    }
    case "text": {
      let text = positional.join("\n");
      if (!positional.length || text === "-") text = await readStdin();
      const d = { ...settings.print, ...settings.text };
      const job = { type: "text", text, ...d, ...opts };
      await output(job, opts, R.printOptions(opts, d));
      break;
    }
    case "qr": {
      const d = { ...settings.print, ...settings.qr };
      const job = { type: "qr", text: positional.join(" "), ...d, ...opts, dither: "threshold" };
      await output(job, opts, R.printOptions({ ...opts, dither: "threshold" }, d));
      break;
    }
    case "feed": {
      const d = { ...settings.print, dither: "threshold" };
      const job = { type: "feed", px: positional[0] ?? settings.feed.px };
      await output(job, opts, R.printOptions(opts, d));
      break;
    }
    case "status": {
      const pm = manager(opts);
      console.error("Looking for MXW01...");
      const state = await pm.status();
      console.log(describeState(state));
      if (state) console.log(JSON.stringify(state));
      await pm.disconnect();
      break;
    }
    case "web": {
      process.argv.splice(2, 1); // hand the remaining args to the server
      require("./server.cjs");
      return; // server keeps running
    }
    default:
      die(`Unknown command "${cmd}"\n\n${HELP}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof R.OptionError ? err.message : "Error: " + (err.message ?? err));
  process.exit(1);
});
