// Rendering for the MXW01: every renderer returns a canvas exactly WIDTH px wide.
// Shared by the CLI (mxprint.cjs) and the web server (server.cjs).

const path = require("path");
require("./fonts.cjs"); // register bundled fonts before any canvas is created
const { createCanvas, loadImage } = require("canvas");
const { styleOf, fontString, STYLES } = require("./fonts.cjs");
const labels = require("./labels.cjs");
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
  const style = opts.style ? styleOf(opts.style) : null;
  const baseSize = num(opts.size, "size", 6, 200, 26);
  const size = style ? Math.round(baseSize * (style.sizeFactor || 1)) : baseSize;
  const family = style ? style.family : opts.mono ? "Liberation Mono" : (opts.font || "Liberation Sans");
  const weight = style && style.weight ? style.weight + " " : opts.bold ? "bold " : "";
  if (style && style.caps) text = String(text).toUpperCase();
  if (style && opts.lineHeight === undefined) opts = { ...opts, lineHeight: style.lineHeight };
  const frame = opts.frame || "none";
  const framePad = frame === "none" ? 0 : 14;
  const align = oneOf(opts.align, "align", ALIGNS, "left");
  const margin = num(opts.margin, "margin", 0, WIDTH / 2 - 1, 10) + framePad;
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

  const pad = Math.round(size * 0.5) + framePad;
  let height = pad * 2;
  for (const b of blocks) height += b.kind === "line" ? b.px * lh : b.kind === "rule" ? size : b.px;

  const canvas = blankCanvas(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.textBaseline = "alphabetic";
  if (frame !== "none") {
    ctx.lineWidth = frame === "double" ? 3 : 4;
    if (frame === "double") { ctx.strokeRect(9.5, 9.5, WIDTH - 19, height - 19); ctx.lineWidth = 1.5; ctx.strokeRect(16, 16, WIDTH - 32, height - 32); }
    else if (frame === "dashed") { ctx.setLineDash([8, 6]); ctx.lineWidth = 2.5; ctx.strokeRect(10, 10, WIDTH - 20, height - 20); ctx.setLineDash([]); }
    else { labels.roundRect(ctx, 10, 10, WIDTH - 20, height - 20, 18); ctx.stroke(); }
  }
  if (opts.ruled) {
    // dotted writing lines under each text line, like a notepad
    ctx.save(); ctx.setLineDash([1, 4]); ctx.lineWidth = 1;
    let ry = pad;
    for (const b of blocks) {
      if (b.kind === "line") { const base = Math.round(ry + b.px * (lh - 0.25)) + 3.5; ctx.beginPath(); ctx.moveTo(margin, base); ctx.lineTo(WIDTH - margin, base); ctx.stroke(); }
      ry += b.kind === "line" ? b.px * lh : b.kind === "rule" ? size : b.px;
    }
    ctx.restore();
  }
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

/**
 * Checklist: title, ☐ rows (done items struck through), optional footer.
 * job: { title, items: [{ text, done, note } | "text"], footer, size, showDone }
 */
function renderChecklist(job) {
  const size = num(job.size, "size", 12, 48, 24);
  const items = (job.items || []).map((i) => (typeof i === "string" ? { text: i } : i || {})).filter((i) => i.text);
  const shown = job.showDone === false ? items.filter((i) => !i.done) : items;
  const box = Math.round(size * 0.85), pitch = Math.round(size * 1.45), margin = 12;
  const measure = createCanvas(1, 1).getContext("2d");
  measure.font = `${size}px "Liberation Sans"`;
  const textX = margin + box + 12, maxWidth = WIDTH - textX - margin;
  // wrap each item; note (e.g. "due Sun", "2 kg") goes in a smaller line below
  const rows = shown.map((i) => {
    const lines = wrapLine(measure, String(i.text), maxWidth).slice(0, 3);
    return { ...i, lines, h: pitch + (lines.length - 1) * Math.round(size * 1.15) + (i.note ? Math.round(size * 0.8) : 0) };
  });
  const titleH = job.title ? Math.round(size * 1.9) + 10 : 0;
  const footerH = job.footer || job.footer === undefined ? Math.round(size * 1.1) + 12 : 0;
  const empty = rows.length ? 0 : Math.round(size * 1.6);
  const total = 10 + titleH + 8 + rows.reduce((a, r) => a + r.h, 0) + empty + footerH + 10;
  const canvas = blankCanvas(total);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black"; ctx.strokeStyle = "black";
  let y = 10;
  if (job.title) {
    ctx.font = `bold ${Math.round(size * 1.3)}px "Liberation Sans"`;
    ctx.fillText(job.title, margin, y + Math.round(size * 1.3));
    if (job.date) { ctx.font = `${Math.round(size * 0.7)}px "Liberation Sans"`; ctx.textAlign = "right"; ctx.fillText(String(job.date), WIDTH - margin, y + Math.round(size * 1.3)); ctx.textAlign = "left"; }
    y += titleH;
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(margin, y + 0.5); ctx.lineTo(WIDTH - margin, y + 0.5); ctx.stroke();
  }
  y += 8;
  if (!rows.length) { ctx.font = `italic ${size}px "Liberation Sans"`; ctx.fillText(job.emptyText || "(nothing on the list)", margin, y + size); y += empty; }
  for (const r of rows) {
    const by = y + Math.round((pitch - box) / 2);
    ctx.lineWidth = 2.5;
    ctx.strokeRect(margin + 1.5, by + 1.5, box - 3, box - 3);
    if (r.done) { ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(margin + 5, by + box / 2); ctx.lineTo(margin + box / 2 - 1, by + box - 6); ctx.lineTo(margin + box - 4, by + 5); ctx.stroke(); }
    ctx.font = `${size}px "Liberation Sans"`;
    let ly = y + Math.round(pitch * 0.72);
    for (const line of r.lines) {
      ctx.fillText(line, textX, ly);
      if (r.done) { const w = ctx.measureText(line).width; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(textX, ly - size * 0.32); ctx.lineTo(textX + w, ly - size * 0.32); ctx.stroke(); }
      ly += Math.round(size * 1.15);
    }
    if (r.note) { ctx.font = `${Math.round(size * 0.7)}px "Liberation Sans"`; ctx.fillText(String(r.note), textX, ly - Math.round(size * 0.35)); }
    y += r.h;
  }
  if (footerH) {
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(margin, y + 4.5); ctx.lineTo(WIDTH - margin, y + 4.5); ctx.stroke();
    ctx.font = `${Math.round(size * 0.75)}px "Liberation Sans"`;
    const open = items.filter((i) => !i.done).length, done = items.length - open;
    ctx.fillText(job.footer || `${open} open${done ? ` · ${done} done` : ""}`, margin, y + 8 + Math.round(size * 0.75));
    y += footerH;
  }
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
    case "checklist":
      canvas = renderChecklist(job);
      break;
    case "fontsheet": {
      // one line per style, to check legibility on paper
      const names = Object.keys(STYLES);
      const rowH = 54, canvasH = 40 + names.length * rowH;
      canvas = blankCanvas(canvasH);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "black";
      ctx.font = 'bold 20px "Liberation Sans"'; ctx.fillText("Font styles", 10, 26);
      let y = 40;
      for (const name of names) {
        const st = STYLES[name];
        const px = Math.round(26 * (st.sizeFactor || 1));
        ctx.font = fontString(st, px);
        const sample = st.caps ? (job.text || "Cuvée No. 1 · 2026").toUpperCase() : (job.text || "Cuvée No. 1 · 2026");
        ctx.fillText(sample, 10, y + 34);
        ctx.font = '11px "Liberation Sans"'; ctx.textAlign = "right"; ctx.fillText(name, WIDTH - 8, y + 12); ctx.textAlign = "left";
        y += rowH;
      }
      break;
    }
    case "label":
      try { canvas = await labels.renderLabel(job); } catch (e) { throw e instanceof labels.OptionError ? new OptionError(e.message) : e; }
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
  invertCanvas, canvasImageData, ditheredPreview, renderJob, renderChecklist,
};
