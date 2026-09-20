// Labels and decorated notes for the MXW01: frames, header bands, vector icons,
// auto-fit display type, cut lines. 384 px wide, 1-bit friendly.
const { createCanvas } = require("canvas");
const QRCode = require("qrcode");
const { styleOf, fontString } = require("./fonts.cjs");

const WIDTH = 384;
class OptionError extends Error {}

function blank(h) {
  const c = createCanvas(WIDTH, Math.max(1, Math.round(h)));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, WIDTH, c.height);
  ctx.fillStyle = "black"; ctx.strokeStyle = "black"; ctx.lineCap = "round"; ctx.lineJoin = "round";
  return c;
}

function num(v, min, max, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

/**
 * Largest font size (<= max) at which text fits in width; returns [px, lines].
 * Prefers a single line when that still gives >= singleLineMin px, otherwise
 * allows up to maxLines lines.
 */
function fitText(ctx, text, style, maxWidth, max, min, maxLines = 2, singleLineMin = 40) {
  if (maxLines > 1) {
    const [px1, lines1] = fitText(ctx, text, style, maxWidth, max, min, 1, 0);
    if (px1 >= singleLineMin && lines1.length === 1 && ctx.measureText(lines1[0]).width <= maxWidth) return [px1, lines1];
  }
  for (let px = max; px >= min; px -= 2) {
    ctx.font = fontString(style, px);
    const words = String(text).split(/\s+/);
    const lines = []; let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width <= maxWidth || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) return [px, lines];
  }
  ctx.font = fontString(style, min);
  return [min, [String(text)]];
}

// ---------------------------------------------------------------------------
// Icons: 1 unit = box of size s at (x, y); all strokes >= 2.5 px
// ---------------------------------------------------------------------------
const ICONS = {
  jar(ctx, s) {
    ctx.lineWidth = 3;
    roundRect(ctx, s * 0.15, s * 0.28, s * 0.7, s * 0.66, s * 0.12); ctx.stroke();
    roundRect(ctx, s * 0.2, s * 0.08, s * 0.6, s * 0.16, s * 0.05); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s * 0.15, s * 0.42); ctx.lineTo(s * 0.85, s * 0.42); ctx.stroke();
  },
  snowflake(ctx, s) {
    ctx.lineWidth = 3; const c = s / 2, r = s * 0.42;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + dx * r, c + dy * r); ctx.stroke();
      const bx = c + dx * r * 0.6, by = c + dy * r * 0.6, b = s * 0.13;
      for (const sgn of [-1, 1]) { const ba = a + sgn * Math.PI / 3.2; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(ba) * b, by + Math.sin(ba) * b); ctx.stroke(); }
    }
  },
  leaf(ctx, s) {
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s * 0.15, s * 0.85); ctx.quadraticCurveTo(s * 0.1, s * 0.2, s * 0.85, s * 0.12); ctx.quadraticCurveTo(s * 0.9, s * 0.8, s * 0.15, s * 0.85); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s * 0.18, s * 0.83); ctx.quadraticCurveTo(s * 0.45, s * 0.5, s * 0.8, s * 0.17); ctx.stroke();
  },
  bottle(ctx, s) {
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s * 0.38, s * 0.06); ctx.lineTo(s * 0.62, s * 0.06); ctx.lineTo(s * 0.62, s * 0.3); ctx.quadraticCurveTo(s * 0.8, s * 0.38, s * 0.8, s * 0.55);
    ctx.lineTo(s * 0.8, s * 0.86); ctx.quadraticCurveTo(s * 0.8, s * 0.94, s * 0.72, s * 0.94); ctx.lineTo(s * 0.28, s * 0.94); ctx.quadraticCurveTo(s * 0.2, s * 0.94, s * 0.2, s * 0.86);
    ctx.lineTo(s * 0.2, s * 0.55); ctx.quadraticCurveTo(s * 0.2, s * 0.38, s * 0.38, s * 0.3); ctx.closePath(); ctx.stroke();
  },
  bread(ctx, s) {
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s * 0.1, s * 0.85); ctx.lineTo(s * 0.1, s * 0.5); ctx.quadraticCurveTo(s * 0.1, s * 0.15, s * 0.5, s * 0.15); ctx.quadraticCurveTo(s * 0.9, s * 0.15, s * 0.9, s * 0.5); ctx.lineTo(s * 0.9, s * 0.85); ctx.closePath(); ctx.stroke();
    ctx.lineWidth = 2; for (const x of [0.3, 0.5, 0.7]) { ctx.beginPath(); ctx.moveTo(s * x - s * 0.06, s * 0.42); ctx.lineTo(s * x + s * 0.06, s * 0.28); ctx.stroke(); }
  },
  fish(ctx, s) {
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s * 0.1, s * 0.5); ctx.quadraticCurveTo(s * 0.35, s * 0.1, s * 0.68, s * 0.5); ctx.quadraticCurveTo(s * 0.35, s * 0.9, s * 0.1, s * 0.5); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * 0.68, s * 0.5); ctx.lineTo(s * 0.9, s * 0.28); ctx.lineTo(s * 0.9, s * 0.72); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * 0.25, s * 0.45, s * 0.04, 0, Math.PI * 2); ctx.fill();
  },
  meat(ctx, s) {
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(s * 0.2, s * 0.35); ctx.quadraticCurveTo(s * 0.3, s * 0.1, s * 0.6, s * 0.15); ctx.quadraticCurveTo(s * 0.92, s * 0.25, s * 0.85, s * 0.6); ctx.quadraticCurveTo(s * 0.75, s * 0.9, s * 0.4, s * 0.85); ctx.quadraticCurveTo(s * 0.1, s * 0.8, s * 0.2, s * 0.35); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * 0.62, s * 0.5, s * 0.1, 0, Math.PI * 2); ctx.stroke();
  },
  cheese(ctx, s) {
    // wedge: top face (triangle, tip to the back) over a front face with holes
    ctx.lineWidth = 3;
    const A = [0.06, 0.6], B = [0.94, 0.6], C = [0.66, 0.2], D = [0.06, 0.9], E = [0.94, 0.9];
    const P = (p) => [s * p[0], s * p[1]];
    // front face
    ctx.beginPath(); ctx.moveTo(...P(A)); ctx.lineTo(...P(B)); ctx.lineTo(...P(E)); ctx.lineTo(...P(D)); ctx.closePath(); ctx.stroke();
    // top face
    ctx.beginPath(); ctx.moveTo(...P(A)); ctx.lineTo(...P(C)); ctx.lineTo(...P(B)); ctx.stroke();
    // holes on the front face (one bitten by the top edge), one on the top face
    ctx.lineWidth = 2.5;
    for (const [x, y, r] of [[0.27, 0.76, 0.065], [0.56, 0.8, 0.05], [0.8, 0.7, 0.04]]) { ctx.beginPath(); ctx.arc(s * x, s * y, s * r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(s * 0.44, s * 0.6, s * 0.055, 0, Math.PI); ctx.stroke(); // half hole on the edge
    ctx.beginPath(); ctx.ellipse(s * 0.5, s * 0.42, s * 0.055, s * 0.032, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(s * 0.7, s * 0.5, s * 0.035, s * 0.02, 0, 0, Math.PI * 2); ctx.stroke();
  },
  heart(ctx, s) {
    ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.9); ctx.bezierCurveTo(s * 0.1, s * 0.6, s * 0.05, s * 0.2, s * 0.5, s * 0.32); ctx.bezierCurveTo(s * 0.95, s * 0.2, s * 0.9, s * 0.6, s * 0.5, s * 0.9); ctx.closePath(); ctx.fill();
  },
  star(ctx, s) {
    ctx.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.2 : s * 0.46, a = -Math.PI / 2 + (i / 10) * Math.PI * 2; ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); } ctx.closePath(); ctx.fill();
  },
  warning(ctx, s) {
    ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.1); ctx.lineTo(s * 0.92, s * 0.88); ctx.lineTo(s * 0.08, s * 0.88); ctx.closePath(); ctx.stroke();
    ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.36); ctx.lineTo(s * 0.5, s * 0.62); ctx.stroke(); ctx.beginPath(); ctx.arc(s * 0.5, s * 0.75, s * 0.035, 0, Math.PI * 2); ctx.fill();
  },
  clock(ctx, s) {
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s / 2, s / 2); ctx.lineTo(s / 2, s * 0.22); ctx.moveTo(s / 2, s / 2); ctx.lineTo(s * 0.7, s * 0.6); ctx.stroke();
  },
  gift(ctx, s) {
    ctx.lineWidth = 3; ctx.strokeRect(s * 0.12, s * 0.38, s * 0.76, s * 0.52); ctx.strokeRect(s * 0.08, s * 0.24, s * 0.84, s * 0.16);
    ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.24); ctx.lineTo(s * 0.5, s * 0.9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.24); ctx.quadraticCurveTo(s * 0.3, s * 0.02, s * 0.32, s * 0.2); ctx.moveTo(s * 0.5, s * 0.24); ctx.quadraticCurveTo(s * 0.7, s * 0.02, s * 0.68, s * 0.2); ctx.stroke();
  },
  sun(ctx, s) {
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.22, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(s / 2 + Math.cos(a) * s * 0.32, s / 2 + Math.sin(a) * s * 0.32); ctx.lineTo(s / 2 + Math.cos(a) * s * 0.46, s / 2 + Math.sin(a) * s * 0.46); ctx.stroke(); }
  },
  cup(ctx, s) {
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(s * 0.15, s * 0.35); ctx.lineTo(s * 0.2, s * 0.85); ctx.lineTo(s * 0.65, s * 0.85); ctx.lineTo(s * 0.7, s * 0.35); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * 0.7, s * 0.45); ctx.quadraticCurveTo(s * 0.95, s * 0.45, s * 0.88, s * 0.65); ctx.quadraticCurveTo(s * 0.82, s * 0.75, s * 0.66, s * 0.72); ctx.stroke();
    ctx.lineWidth = 2; for (const x of [0.32, 0.45]) { ctx.beginPath(); ctx.moveTo(s * x, s * 0.28); ctx.quadraticCurveTo(s * (x + 0.06), s * 0.18, s * x, s * 0.08); ctx.stroke(); }
  },
};
const ICON_NAMES = Object.keys(ICONS);

function drawIcon(ctx, name, x, y, size, invert = false) {
  const fn = ICONS[String(name || "").toLowerCase()];
  if (!fn) return false;
  ctx.save(); ctx.translate(x, y);
  if (invert) { ctx.strokeStyle = "white"; ctx.fillStyle = "white"; }
  fn(ctx, size); ctx.restore();
  return true;
}

function cutLine(ctx, y) {
  ctx.save(); ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(30, y + 0.5); ctx.lineTo(WIDTH - 8, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '14px "Liberation Sans"'; ctx.fillText("✂", 8, y + 5); ctx.restore();
}

function todayStr(v) {
  if (v === true || v === "today") {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return v ? String(v) : "";
}

/**
 * job: {
 *   text (required), sub, date (string | true), note,
 *   icon (jar|snowflake|leaf|bottle|bread|fish|meat|cheese|heart|star|warning|clock|gift|sun|cup),
 *   qr (string), band (string, inverted header bar e.g. "FREEZER"),
 *   frame ("rounded" default | "double" | "ticket" | "none"),
 *   font ("display" default | marker | handwriting | casual | script | sans),
 *   count (copies with cut lines), height (min label height, default auto)
 * }
 */
async function renderLabel(job) {
  if (!job.text) throw new OptionError("label: text is required");
  const font = styleOf(job.font || "display");
  const subFont = styleOf(job.subFont || (job.font === "display" || !job.font ? "sans" : job.font));
  const frame = job.frame || "rounded";
  const count = Math.max(1, Math.min(20, Number(job.count) || 1));
  const M = 10, PAD = 16;
  const hasQr = !!job.qr, hasIcon = !!ICONS[String(job.icon || "").toLowerCase()];
  const qrSize = hasQr ? 112 : 0, iconSize = hasIcon && !hasQr ? 64 : hasIcon ? 44 : 0;
  const bandH = job.band ? 34 : 0;
  const rightW = hasQr ? qrSize + PAD : 0;
  const leftW = hasIcon ? iconSize + PAD : 0;
  const textW = WIDTH - 2 * M - 2 * PAD - rightW - leftW;

  // measure
  const mc = createCanvas(1, 1).getContext("2d");
  const [titlePx, titleLines] = fitText(mc, job.text, font, textW, job.maxSize || 88, 26, 2);
  const titleLH = Math.round(titlePx * (font.lineHeight || 1.1));
  let subPx = 0, subLines = [];
  if (job.sub) { [subPx, subLines] = fitText(mc, job.sub, subFont, textW, 28, 18, 2); }
  const subLH = subPx ? Math.round(subPx * 1.25) : 0;
  const dateStr = todayStr(job.date); const noteStr = job.note ? String(job.note) : "";
  const smallH = dateStr || noteStr ? 24 : 0;
  const details = Array.isArray(job.details) ? job.details.map((d) => String(d)).filter(Boolean) : [];
  const detailPx = num(job.detailSize, 12, 24, 17), detailLH = Math.round(detailPx * 1.35);
  const detailsH = details.length ? details.length * detailLH + 8 : 0;
  const textBlockH = titleLines.length * titleLH + (subLines.length ? subLines.length * subLH + 4 : 0) + detailsH + smallH;
  const innerH = Math.max(textBlockH, qrSize, iconSize) + 2 * PAD;
  const labelH = Math.max(Number(job.height) || 0, bandH + innerH + 2 * M);
  const canvas = blank(labelH * count);
  const ctx = canvas.getContext("2d");

  for (let n = 0; n < count; n++) {
    const oy = n * labelH;
    const x0 = M, y0 = oy + M, w = WIDTH - 2 * M, h = labelH - 2 * M;
    ctx.fillStyle = "black"; ctx.strokeStyle = "black";
    // frame
    if (frame === "rounded") { ctx.lineWidth = 4; roundRect(ctx, x0 + 2, y0 + 2, w - 4, h - 4, 18); ctx.stroke(); }
    else if (frame === "double") { ctx.lineWidth = 3; ctx.strokeRect(x0 + 1.5, y0 + 1.5, w - 3, h - 3); ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 8, y0 + 8, w - 16, h - 16); }
    else if (frame === "ticket") {
      const sx = hasQr ? x0 + w - PAD - qrSize - PAD / 2 : x0 + w * 0.72; // perforation, left of the QR if any
      ctx.lineWidth = 3; roundRect(ctx, x0 + 1.5, y0 + 1.5, w - 3, h - 3, 10); ctx.stroke();
      ctx.fillStyle = "white"; for (const cy of [y0 + 1.5, y0 + h - 1.5]) { ctx.beginPath(); ctx.arc(sx, cy, 9, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = "black"; ctx.lineWidth = 3; for (const cy of [y0 + 1.5, y0 + h - 1.5]) { ctx.beginPath(); ctx.arc(sx, cy, 9, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = "white"; ctx.fillRect(sx - 10, y0 - 2, 20, 4); ctx.fillRect(sx - 10, y0 + h - 2, 20, 4); ctx.fillStyle = "black";
      ctx.setLineDash([4, 5]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx, y0 + 12); ctx.lineTo(sx, y0 + h - 12); ctx.stroke(); ctx.setLineDash([]);
    }
    // band
    let cy = y0 + (frame === "none" ? 0 : 4);
    if (job.band) {
      ctx.fillStyle = "black";
      if (frame === "rounded") { roundRect(ctx, x0 + 4, y0 + 4, w - 8, bandH + 12, 14); ctx.fill(); ctx.fillRect(x0 + 4, y0 + 4 + bandH - 6, w - 8, 18); }
      else ctx.fillRect(x0 + 4, y0 + 4, w - 8, bandH);
      ctx.fillStyle = "white"; ctx.font = fontString(styleOf("display"), 26); ctx.textAlign = "center";
      ctx.fillText(String(job.band).toUpperCase(), x0 + w / 2, y0 + 4 + 27); ctx.textAlign = "left"; ctx.fillStyle = "black";
      cy += bandH + 4;
    }
    // content box
    const cx0 = x0 + PAD, contentH = h - (cy - y0) - 4, cyMid = cy + contentH / 2;
    let tx = cx0;
    if (hasIcon) { drawIcon(ctx, job.icon, cx0, cyMid - iconSize / 2, iconSize); tx += iconSize + PAD; }
    if (hasQr) {
      const q = createCanvas(qrSize, qrSize);
      await QRCode.toCanvas(q, String(job.qr), { width: qrSize, margin: 0, errorCorrectionLevel: "M" });
      ctx.drawImage(q, x0 + w - PAD - qrSize, cyMid - qrSize / 2);
    }
    let ty = cyMid - textBlockH / 2;
    ctx.font = fontString(font, titlePx);
    for (const line of titleLines) { ctx.fillText(font.caps ? line.toUpperCase() : line, tx, ty + titlePx * 0.85); ty += titleLH; }
    if (subLines.length) { ty += 4; ctx.font = fontString(subFont, subPx); for (const line of subLines) { ctx.fillText(line, tx, ty + subPx * 0.8); ty += subLH; } }
    if (details.length) {
      ty += 8; ctx.font = `${detailPx}px "Liberation Sans"`;
      for (const line of details) { ctx.fillText(line, tx, ty + detailPx * 0.8); ty += detailLH; }
    }
    if (smallH) {
      ctx.font = '16px "Liberation Sans"';
      const parts = [dateStr, noteStr].filter(Boolean).join("  ·  ");
      ctx.fillText(parts, tx, ty + 17);
    }
    if (n < count - 1) cutLine(ctx, oy + labelH - 0.5);
  }
  return canvas;
}

module.exports = { renderLabel, drawIcon, ICON_NAMES, roundRect, fitText, cutLine, OptionError };
