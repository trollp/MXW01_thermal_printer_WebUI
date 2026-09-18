// Rendering for the MXW01: every renderer returns a canvas exactly WIDTH px wide.
// Shared by the CLI (mxprint.cjs) and the web server (server.cjs).

const path = require("path");
const { createCanvas, loadImage } = require("canvas");
const QRCode = require("qrcode");
const { processImageForPrinter } = require("mxw01-thermal-printer");
const charts = require("./charts.cjs");

const WIDTH = 384;
const DITHERS = ["threshold", "steinberg", "bayer", "atkinson", "pattern"];
const FLIPS = ["none", "h", "v", "both"];
const ROTATIONS = [0, 90, 180, 270];
const ALIGNS = ["left", "center", "right"];

class OptionError extends Error {}

function num(v, name, min, max, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new OptionError(`${name} must be a number between ${min} and ${max}`);
  return n;
}

function oneOf(v, name, list, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const val = typeof list[0] === "number" ? Number(v) : v;
  if (!list.includes(val)) throw new OptionError(`${name} must be one of ${list.join(", ")}`);
  return val;
}

/** Validate the options that go to printer.print(). */
function printOptions(opts, defaults = {}) {
  return {
    dither: oneOf(opts.dither, "dither", DITHERS, defaults.dither ?? "steinberg"),
    rotate: oneOf(opts.rotate, "rotate", ROTATIONS, defaults.rotate ?? 0),
    flip: oneOf(opts.flip, "flip", FLIPS, defaults.flip ?? "none"),
    brightness: num(opts.brightness, "brightness", 0, 255, defaults.brightness ?? 128),
    intensity: num(opts.intensity, "intensity", 0, 255, defaults.intensity ?? 93),
  };
}

function blankCanvas(height) {
  const canvas = createCanvas(WIDTH, Math.max(1, Math.round(height)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function stackCanvases(canvases, gap = 0) {
  if (canvases.length === 1) return canvases[0];
  const total = canvases.reduce((h, c) => h + c.height, 0) + gap * (canvases.length - 1);
  const out = blankCanvas(total);
  const ctx = out.getContext("2d");
  let y = 0;
  for (const c of canvases) {
    ctx.drawImage(c, 0, y);
    y += c.height + gap;
  }
  return out;
}

/**
 * @param source file path or Buffer
 * @param opts { noScale }
 */
async function renderImage(source, opts = {}) {
  let img;
  try {
    img = await loadImage(Buffer.isBuffer(source) ? source : path.resolve(source));
  } catch (err) {
    throw new OptionError(`Cannot load image${Buffer.isBuffer(source) ? "" : " " + source}: ${err.message}`);
  }
  let w = img.width, h = img.height;
  if (!opts.noScale) {
    const s = WIDTH / img.width;
    w = WIDTH;
    h = Math.round(img.height * s);
  }
  const canvas = blankCanvas(h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function wrapLine(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    const candidate = cur ? cur + " " + word : word;
    if (ctx.measureText(candidate).width <= maxWidth || !cur) cur = candidate;
    else { lines.push(cur); cur = word; }
  }
  // break words that are wider than the line on their own
  const out = [];
  for (const line of [...lines, cur]) {
    if (ctx.measureText(line).width <= maxWidth) { out.push(line); continue; }
    let piece = "";
    for (const ch of line) {
      if (ctx.measureText(piece + ch).width > maxWidth && piece) { out.push(piece); piece = ch; }
      else piece += ch;
    }
    if (piece) out.push(piece);
  }
  return out.length ? out : [""];
}

/**
 * Light markup: "# " big heading, "## " heading, "---" rule, blank line = paragraph gap.
 * @param opts { size, font, mono, bold, align, margin, lineHeight }
 */
function renderText(text, opts = {}) {
  const size = num(opts.size, "size", 6, 200, 26);
  const family = opts.mono ? "Liberation Mono" : (opts.font || "Liberation Sans");
  const weight = opts.bold ? "bold " : "";
  const align = oneOf(opts.align, "align", ALIGNS, "left");
  const margin = num(opts.margin, "margin", 0, WIDTH / 2 - 1, 10);
  const lh = num(opts.lineHeight, "line-height", 0.8, 3, 1.25);
  const maxWidth = WIDTH - 2 * margin;

  // Lay out first with a measuring context, then draw to a canvas of the right height.
  const measure = createCanvas(1, 1).getContext("2d");
  const blocks = []; // {kind:'line', text, font, px} | {kind:'rule'} | {kind:'gap', px}
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "---") { blocks.push({ kind: "rule" }); continue; }
    if (line.trim() === "") { blocks.push({ kind: "gap", px: size * 0.6 }); continue; }
    let px = size, w = weight, body = line;
    if (line.startsWith("# ")) { px = Math.round(size * 1.8); w = "bold "; body = line.slice(2); }
    else if (line.startsWith("## ")) { px = Math.round(size * 1.35); w = "bold "; body = line.slice(3); }
    const font = `${w}${px}px "${family}"`;
    measure.font = font;
    for (const l of wrapLine(measure, body, maxWidth)) blocks.push({ kind: "line", text: l, font, px });
  }

  const pad = Math.round(size * 0.5);
  let height = pad * 2;
  for (const b of blocks) height += b.kind === "line" ? b.px * lh : b.kind === "rule" ? size : b.px;

  const canvas = blankCanvas(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.textBaseline = "alphabetic";
  let y = pad;
  for (const b of blocks) {
    if (b.kind === "gap") { y += b.px; continue; }
    if (b.kind === "rule") {
      ctx.fillRect(margin, Math.round(y + size / 2), maxWidth, 2);
      y += size;
      continue;
    }
    ctx.font = b.font;
    const tw = ctx.measureText(b.text).width;
    const x = align === "center" ? (WIDTH - tw) / 2 : align === "right" ? WIDTH - margin - tw : margin;
    ctx.fillText(b.text, Math.round(x), Math.round(y + b.px * (lh - 0.25)));
    y += b.px * lh;
  }
  return canvas;
}

/** @param opts { size, label, labelSize } */
async function renderQr(text, opts = {}) {
  if (!text) throw new OptionError("QR text is empty");
  const size = num(opts.size, "size", 64, WIDTH, 300);
  const qr = createCanvas(size, size);
  await QRCode.toCanvas(qr, text, { width: size, margin: 1, errorCorrectionLevel: "M" });
  const label = opts.label ? renderText(opts.label, { size: opts.labelSize ?? 22, align: "center", font: opts.font, mono: opts.mono }) : null;
  const canvas = blankCanvas(size + 16 + (label ? label.height : 0));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(qr, Math.round((WIDTH - size) / 2), 8);
  if (label) ctx.drawImage(label, 0, size + 8);
  return canvas;
}

/** A labelled strip with a gradient and a soft shape, to compare dither modes on paper. */
function renderTestStrip(dither) {
  const canvas = blankCanvas(120);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.font = 'bold 20px "Liberation Sans"';
  ctx.fillText(dither, 10, 26);
  const g = ctx.createLinearGradient(10, 0, WIDTH - 10, 0);
  g.addColorStop(0, "black");
  g.addColorStop(1, "white");
  ctx.fillStyle = g;
  ctx.fillRect(10, 40, WIDTH - 20, 30);
  const r = ctx.createRadialGradient(80, 95, 2, 80, 95, 24);
  r.addColorStop(0, "black");
  r.addColorStop(1, "white");
  ctx.fillStyle = r;
  ctx.fillRect(10, 75, 140, 40);
  ctx.fillStyle = "black";
  ctx.font = '13px "Liberation Sans"';
  ctx.fillText("small text sample 0123", 170, 100);
  return canvas;
}

function invertCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function canvasImageData(canvas) {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
}

/** Run the library's dither/rotate pipeline and return a 1-bit canvas of what will be printed. */
function ditheredPreview(canvas, popts) {
  const { binaryRows } = processImageForPrinter(canvasImageData(canvas), popts);
  const out = createCanvas(WIDTH, binaryRows.length);
  const ctx = out.getContext("2d");
  const img = ctx.createImageData(WIDTH, binaryRows.length);
  const d = img.data;
  for (let y = 0; y < binaryRows.length; y++) {
    const row = binaryRows[y];
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const v = row[x] ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Build the canvas for a print job description shared by CLI and web UI:
 * { type: 'text'|'image'|'qr'|'feed', text, images: [path|Buffer], gap, invert, ...renderer opts }
 */
async function renderJob(job) {
  let canvas;
  switch (job.type) {
    case "text":
      if (!job.text || !String(job.text).trim()) throw new OptionError("nothing to print");
      canvas = renderText(job.text, job);
      break;
    case "image": {
      if (!job.images || !job.images.length) throw new OptionError("no image given");
      const gap = num(job.gap, "gap", 0, 2000, 24);
      const parts = [];
      for (const src of job.images) parts.push(await renderImage(src, job));
      canvas = stackCanvases(parts, gap);
      break;
    }
    case "qr":
      canvas = await renderQr(job.text, job);
      break;
    case "feed":
      canvas = blankCanvas(num(job.px, "feed", 1, 4000, 120));
      break;
    case "test":
      canvas = renderTestStrip(job.dither || "steinberg");
      break;
    case "chart":
      try { canvas = charts.renderChart(job); } catch (e) { throw e instanceof charts.OptionError ? new OptionError(e.message) : e; }
      break;
    case "forecast":
      try { canvas = charts.renderForecast(job); } catch (e) { throw e instanceof charts.OptionError ? new OptionError(e.message) : e; }
      break;
    default:
      throw new OptionError(`unknown job type "${job.type}"`);
  }
  if (job.invert) invertCanvas(canvas);
  return canvas;
}

module.exports = {
  WIDTH, DITHERS, FLIPS, ROTATIONS, ALIGNS, OptionError,
  printOptions, blankCanvas, stackCanvases, renderImage, renderText, renderQr,
  invertCanvas, canvasImageData, ditheredPreview, renderJob,
};
