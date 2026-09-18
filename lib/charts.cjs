// Chart and weather-forecast renderers for the MXW01 (384 px wide, 1-bit).
// Everything is drawn with canvas primitives so it survives thresholding:
// solid black lines >= 2 px, dotted grids, no grey fills, no icon fonts.

const { createCanvas } = require("canvas");

const WIDTH = 384;
const FONT = "Liberation Sans";
const f = (px, bold = false) => `${bold ? "bold " : ""}${px}px "${FONT}"`;

class OptionError extends Error {}

function blank(height) {
  const c = createCanvas(WIDTH, Math.max(1, Math.round(height)));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, WIDTH, c.height);
  ctx.fillStyle = "black";
  ctx.strokeStyle = "black";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  return c;
}

function fmtNum(v, digits) {
  if (!Number.isFinite(v)) return "–";
  if (digits !== undefined) return v.toFixed(digits);
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/\.?0+$/, "");
}

/** "Nice" tick step for a range, aiming for ~n ticks. */
function niceStep(range, n) {
  const raw = range / Math.max(1, n);
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

const pad2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toX(t) {
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new OptionError(`bad time value "${t}"`);
  return ms;
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------
/**
 * job: {
 *   title, subtitle, unit,
 *   series: [{ label, points: [[t, v], ...] }]   t = ms epoch | ISO string | number; v = number|null (gap)
 *   height (plot height, default 220), yMin, yMax, decimals, stats (default true), timeAxis (default true)
 * }
 */
function renderChart(job) {
  const series = (job.series || []).filter((s) => s && Array.isArray(s.points));
  if (!series.length) throw new OptionError("chart: no series");
  const isTime = job.timeAxis !== false && series.some((s) => s.points.some((p) => typeof p[0] === "string"));

  // Normalise + downsample (paper can't show more than a few hundred points anyway)
  const data = series.map((s) => {
    let pts = s.points.map((p) => [toX(p[0]), p[1] === null || p[1] === undefined || p[1] === "" ? null : Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && (p[1] === null || Number.isFinite(p[1])))
      .sort((a, b) => a[0] - b[0]);
    if (pts.length > 800) { const k = Math.ceil(pts.length / 800); pts = pts.filter((_, i) => i % k === 0); }
    return { label: s.label || "", pts };
  });
  const all = data.flatMap((s) => s.pts);
  const vals = all.map((p) => p[1]).filter((v) => v !== null);
  if (!vals.length) throw new OptionError("chart: no numeric values");

  const xMin = Math.min(...all.map((p) => p[0])), xMax = Math.max(...all.map((p) => p[0]));
  let yMin = job.yMin !== undefined ? Number(job.yMin) : Math.min(...vals);
  let yMax = job.yMax !== undefined ? Number(job.yMax) : Math.max(...vals);
  if (yMax === yMin) { yMin -= 1; yMax += 1; }
  const yStep = niceStep(yMax - yMin, 4);
  if (job.yMin === undefined) yMin = Math.floor(yMin / yStep) * yStep;
  if (job.yMax === undefined) yMax = Math.ceil(yMax / yStep) * yStep;

  // Layout
  const titleH = job.title ? 30 : 0;
  const subH = job.subtitle ? 20 : 0;
  const legendH = data.length > 1 ? 20 : 0;
  const plotH = Math.max(80, Math.min(600, Number(job.height) || 220));
  const axisBottom = 22;
  const statsH = job.stats === false ? 0 : 22;
  const top = 8 + titleH + subH + legendH;
  const c = blank(top + plotH + axisBottom + statsH + 8);
  const ctx = c.getContext("2d");

  let y = 8;
  if (job.title) { ctx.font = f(20, true); ctx.fillText(job.title, 8, y + 20); y += titleH; }
  if (job.subtitle) { ctx.font = f(13); ctx.fillText(job.subtitle, 8, y + 14); y += subH; }

  const dashes = [[], [7, 4], [2, 4]];
  if (legendH) {
    ctx.font = f(13);
    let x = 8;
    data.forEach((s, i) => {
      ctx.setLineDash(dashes[i % 3]); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x, y + 10); ctx.lineTo(x + 22, y + 10); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(s.label, x + 27, y + 14);
      x += 27 + ctx.measureText(s.label).width + 14;
    });
    y += legendH;
  }

  // Axis label width
  ctx.font = f(12);
  const decimals = job.decimals !== undefined ? Number(job.decimals) : (yStep >= 1 ? 0 : yStep >= 0.1 ? 1 : 2);
  const ticks = [];
  for (let v = yMin; v <= yMax + 1e-9; v += yStep) ticks.push(v);
  const labelW = Math.max(...ticks.map((v) => ctx.measureText(fmtNum(v, decimals)).width)) + 6;
  const left = 8 + labelW, right = WIDTH - 10;
  const plotTop = y, plotBottom = y + plotH;
  const sx = (t) => left + ((t - xMin) / (xMax - xMin || 1)) * (right - left);
  const sy = (v) => plotBottom - ((v - yMin) / (yMax - yMin)) * plotH;

  // Grid + y labels
  ctx.textAlign = "right";
  for (const v of ticks) {
    const yy = Math.round(sy(v)) + 0.5;
    ctx.setLineDash([1, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(fmtNum(v, decimals), left - 4, yy + 4);
  }
  ctx.textAlign = "left";
  if (job.unit) { ctx.font = f(11); ctx.textAlign = "right"; ctx.fillText(String(job.unit), right, plotTop - 3); ctx.textAlign = "left"; }

  // X ticks
  ctx.font = f(12);
  const xt = [];
  if (isTime) {
    const span = xMax - xMin;
    const hour = 3600e3, day = 24 * hour;
    const step = span <= 3 * hour ? 0.5 * hour : span <= 8 * hour ? hour : span <= 30 * hour ? 6 * hour : span <= 3.5 * day ? 12 * hour : span <= 10 * day ? day : Math.ceil(span / (6 * day)) * day;
    const fmt = span <= 30 * hour ? (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      : span <= 3.5 * day ? (d) => (d.getHours() === 0 ? `${DAYS[d.getDay()]} ${d.getDate()}` : `${pad2(d.getHours())}h`)
      : (d) => `${DAYS[d.getDay()]} ${d.getDate()}`;
    // align ticks to local midnight so hour ticks land on 00/06/12/18
    const d0 = new Date(xMin); d0.setHours(0, 0, 0, 0);
    let t = d0.getTime();
    while (t < xMin) t += step;
    for (; t <= xMax; t += step) xt.push([t, fmt(new Date(t))]);
  } else {
    const step = niceStep(xMax - xMin, 5);
    for (let v = Math.ceil(xMin / step) * step; v <= xMax; v += step) xt.push([v, fmtNum(v)]);
  }
  ctx.textAlign = "center";
  let lastLabelX = -1e9;
  for (const [t, label] of xt) {
    const xx = Math.round(sx(t)) + 0.5;
    ctx.setLineDash([1, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xx, plotTop); ctx.lineTo(xx, plotBottom); ctx.stroke();
    ctx.setLineDash([]);
    const w = ctx.measureText(label).width;
    if (xx - w / 2 > lastLabelX + 6 && xx + w / 2 < WIDTH) { ctx.fillText(label, xx, plotBottom + 15); lastLabelX = xx + w / 2; }
  }
  ctx.textAlign = "left";

  // Frame
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left + 0.5, plotTop + 0.5, right - left, plotH);

  // Series
  data.forEach((s, i) => {
    ctx.setLineDash(dashes[i % 3]);
    ctx.lineWidth = i === 0 ? 2.5 : 2;
    ctx.beginPath();
    let pen = false;
    for (const [t, v] of s.pts) {
      if (v === null) { pen = false; continue; }
      const x = sx(t), yy = Math.min(plotBottom, Math.max(plotTop, sy(v)));
      if (!pen) { ctx.moveTo(x, yy); pen = true; } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Min / max / last markers for the first series
  const s0 = data[0].pts.filter((p) => p[1] !== null);
  if (s0.length) {
    const mn = s0.reduce((a, p) => (p[1] < a[1] ? p : a)), mx = s0.reduce((a, p) => (p[1] > a[1] ? p : a));
    for (const p of [mn, mx]) { ctx.beginPath(); ctx.arc(sx(p[0]), sy(p[1]), 3.5, 0, Math.PI * 2); ctx.fill(); }
    if (statsH) {
      const last = s0[s0.length - 1];
      ctx.font = f(13);
      const u = job.unit ? ` ${job.unit}` : "";
      ctx.fillText(`min ${fmtNum(mn[1])}${u}   max ${fmtNum(mx[1])}${u}   last ${fmtNum(last[1])}${u}`, 8, plotBottom + axisBottom + 15);
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Weather icons (44 x 44 box, drawn at x, y)
// ---------------------------------------------------------------------------
function sun(ctx, cx, cy, r) {
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r + 4), cy + Math.sin(a) * (r + 4)); ctx.lineTo(cx + Math.cos(a) * (r + 9), cy + Math.sin(a) * (r + 9)); ctx.stroke();
  }
}
function cloud(ctx, x, y, w, fill = false) {
  // x,y = bottom-left of the cloud, w = width
  const h = w * 0.55;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.2, y);
  ctx.arc(x + w * 0.3, y - h * 0.35, h * 0.35, Math.PI * 0.6, Math.PI * 1.45);
  ctx.arc(x + w * 0.55, y - h * 0.62, h * 0.42, Math.PI * 1.1, Math.PI * 1.9);
  ctx.arc(x + w * 0.78, y - h * 0.35, h * 0.32, Math.PI * 1.35, Math.PI * 0.45);
  ctx.lineTo(x + w * 0.2, y);
  ctx.closePath();
  if (fill) { ctx.fillStyle = "white"; ctx.fill(); ctx.fillStyle = "black"; }
  ctx.stroke();
}
function rainLines(ctx, x, y, n, len = 8) {
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) { const xx = x + i * 8; ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx - 3, y + len); ctx.stroke(); }
}
function snowFlakes(ctx, x, y, n) {
  ctx.lineWidth = 1.5;
  for (let i = 0; i < n; i++) {
    const cx = x + i * 9, cy = y + (i % 2) * 3;
    for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI; ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 3.5, cy - Math.sin(a) * 3.5); ctx.lineTo(cx + Math.cos(a) * 3.5, cy + Math.sin(a) * 3.5); ctx.stroke(); }
  }
}
function bolt(ctx, x, y) {
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 4, y); ctx.lineTo(x, y + 7); ctx.lineTo(x + 4, y + 7); ctx.lineTo(x, y + 14); ctx.stroke();
}
function moon(ctx, cx, cy, r) {
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 0.25, Math.PI * 1.75);
  ctx.arc(cx + r * 0.55, cy - r * 0.15, r * 0.85, Math.PI * 1.55, Math.PI * 0.45, true);
  ctx.closePath(); ctx.stroke();
}
function drawWeatherIcon(ctx, condition, x, y) {
  const c = String(condition || "").toLowerCase();
  ctx.save();
  ctx.translate(x, y);
  if (c === "sunny" || c === "clear") sun(ctx, 22, 22, 9);
  else if (c === "clear-night") moon(ctx, 22, 22, 12);
  else if (c === "partlycloudy") { sun(ctx, 16, 14, 7); cloud(ctx, 8, 40, 32, true); }
  else if (c === "cloudy") cloud(ctx, 4, 34, 36);
  else if (c === "rainy" || c === "windy-variant") { cloud(ctx, 4, 28, 36); rainLines(ctx, 14, 33, 3); }
  else if (c === "pouring") { cloud(ctx, 4, 26, 36); rainLines(ctx, 10, 31, 4, 11); }
  else if (c === "snowy") { cloud(ctx, 4, 28, 36); snowFlakes(ctx, 12, 37, 3); }
  else if (c === "snowy-rainy") { cloud(ctx, 4, 28, 36); rainLines(ctx, 12, 33, 2); snowFlakes(ctx, 30, 37, 1); }
  else if (c === "hail") { cloud(ctx, 4, 28, 36); for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(14 + i * 8, 37, 2.2, 0, Math.PI * 2); ctx.fill(); } }
  else if (c === "lightning") { cloud(ctx, 4, 28, 36); bolt(ctx, 18, 30); }
  else if (c === "lightning-rainy") { cloud(ctx, 4, 28, 36); bolt(ctx, 12, 30); rainLines(ctx, 26, 33, 2); }
  else if (c === "fog") { ctx.lineWidth = 2.5; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(6, 12 + i * 8); ctx.lineTo(38 - (i % 2) * 8, 12 + i * 8); ctx.stroke(); } }
  else if (c === "windy") { ctx.lineWidth = 2.5; [[4, 14, 30], [8, 22, 34], [4, 30, 26]].forEach(([x0, yy, x1]) => { ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.arc(x1, yy - 3, 3, Math.PI / 2, -Math.PI / 2, true); ctx.stroke(); }); }
  else if (c === "exceptional") { ctx.font = f(30, true); ctx.fillText("!", 16, 33); }
  else { ctx.font = f(13); ctx.fillText("?", 18, 27); }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------
/**
 * job: {
 *   title, unit ("°C"), place,
 *   now: { temperature, condition, text },                       optional header line
 *   days: [{ label, date, condition, high, low, precipitation, precipitationProbability, wind, windUnit }]
 *   maxDays (default 7)
 * }
 * label defaults to weekday from `date` (YYYY-MM-DD or ISO).
 */
function renderForecast(job) {
  const unit = job.unit || "°";
  // Wind is shown in m/s; convert from the unit the source reports (Home Assistant: wind_speed_unit)
  const toMs = (v, u) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return undefined;
    const uu = String(u || "m/s").toLowerCase();
    return uu === "kn" || uu === "kt" || uu === "knots" ? x * 0.5144 : uu === "km/h" || uu === "kph" ? x / 3.6 : uu === "mph" ? x * 0.447 : uu === "ft/s" ? x * 0.3048 : x;
  };
  let days = (job.days || []).slice(0, Math.max(1, Number(job.maxDays) || 7)).map((d) => {
    let label = d.label;
    const date = d.date ?? d.datetime;
    if (!label && date) { const dt = new Date(date); if (!Number.isNaN(dt.getTime())) label = `${DAYS[dt.getDay()]} ${dt.getDate()}`; }
    const high = Number(d.high ?? d.temperature), low = Number(d.low ?? d.templow);
    return { label: label || "", condition: d.condition, high, low: Number.isFinite(low) ? low : high, precip: Number(d.precipitation) || 0, prob: d.precipitationProbability ?? d.precipitation_probability, wind: toMs(d.wind ?? d.wind_speed, d.windUnit ?? job.windUnit), windUnit: "m/s" };
  }).filter((d) => Number.isFinite(d.high));
  if (!days.length) throw new OptionError("forecast: no days");
  if (days.every((d) => d.label === days[0].label)) days = days.map((d, i) => ({ ...d, label: d.label || `Day ${i + 1}` }));

  const rowH = 58, headH = 8 + (job.title ? 30 : 0) + (job.now ? 52 : 0) + 6;
  const c = blank(headH + days.length * rowH + 10);
  const ctx = c.getContext("2d");
  let y = 8;
  if (job.title) { ctx.font = f(20, true); ctx.fillText(job.title, 8, y + 20); y += 30; }
  if (job.now) {
    drawWeatherIcon(ctx, job.now.condition, 8, y);
    ctx.font = f(28, true);
    const t = Number.isFinite(Number(job.now.temperature)) ? `${fmtNum(Number(job.now.temperature), 1)}${unit}` : "";
    ctx.fillText(t, 60, y + 32);
    const tw = ctx.measureText(t).width;
    ctx.font = f(13);
    let text = job.now.text || String(job.now.condition || "").replace(/-/g, " ");
    if (!job.now.text) {
      const extras = [];
      if (Number.isFinite(Number(job.now.humidity))) extras.push(`${Math.round(Number(job.now.humidity))} % humidity`);
      const w = toMs(job.now.wind ?? job.now.wind_speed, job.now.windUnit ?? job.windUnit);
      if (w !== undefined) extras.push(`wind ${w.toFixed(0)} m/s`);
      if (extras.length) text += ", " + extras.join(", ");
    }
    ctx.fillText(text, 60 + tw + 12, y + 30);
    y += 52;
  }
  ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(8, y + 0.5); ctx.lineTo(WIDTH - 8, y + 0.5); ctx.stroke();
  y += 6;

  const tMin = Math.min(...days.map((d) => d.low)), tMax = Math.max(...days.map((d) => d.high));
  const barL = 176, barR = 300;
  const bx = (t) => barL + ((t - tMin) / (tMax - tMin || 1)) * (barR - barL);

  for (const d of days) {
    const cy = y + rowH / 2;
    ctx.font = f(15, true); ctx.fillText(d.label, 8, cy + 5);
    drawWeatherIcon(ctx, d.condition, 62, cy - 22);
    // low / high with range bar
    ctx.font = f(15);
    ctx.textAlign = "right"; ctx.fillText(`${fmtNum(d.low, 0)}${unit}`, barL - 6, cy + 5);
    ctx.textAlign = "left"; ctx.fillText(`${fmtNum(d.high, 0)}${unit}`, barR + 6, cy + 5);
    ctx.setLineDash([1, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(barL, cy + 0.5); ctx.lineTo(barR, cy + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(bx(d.low), cy); ctx.lineTo(Math.max(bx(d.low) + 3, bx(d.high)), cy); ctx.stroke();
    // precipitation / wind line
    ctx.font = f(11);
    const bits = [];
    if (d.precip > 0) bits.push(`${fmtNum(d.precip, 1)} mm${Number.isFinite(Number(d.prob)) ? ` (${Math.round(d.prob)}%)` : ""}`);
    if (Number.isFinite(Number(d.wind))) bits.push(`wind ${fmtNum(Number(d.wind), 0)} ${d.windUnit}`);
    if (bits.length) ctx.fillText(bits.join("  ·  "), 112, cy + 22);
    // precipitation bar (0..10 mm scale) at the far right
    if (d.precip > 0) { const h = Math.min(30, 3 + d.precip * 3); ctx.fillRect(WIDTH - 22, cy + 6 - h, 8, h); }
    y += rowH;
    ctx.setLineDash([1, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(8, y - 3.5); ctx.lineTo(WIDTH - 8, y - 3.5); ctx.stroke(); ctx.setLineDash([]);
  }
  return c;
}

module.exports = { renderChart, renderForecast, drawWeatherIcon, OptionError };
