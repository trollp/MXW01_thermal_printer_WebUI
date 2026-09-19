// Bundled open fonts (OFL / Apache, see fonts/), registered with node-canvas so
// prints look the same on every machine. Must be required before any canvas
// is created (render.cjs and charts.cjs do so at load time).
const path = require("path");
const fs = require("fs");
const { registerFont } = require("canvas");

const DIR = path.join(__dirname, "..", "fonts");
const FACES = [
  ["BebasNeue-Regular.ttf", { family: "Bebas Neue" }],
  ["PermanentMarker-Regular.ttf", { family: "Permanent Marker" }],
  ["Kalam-Bold.ttf", { family: "Kalam", weight: "bold" }],
  ["PatrickHand-Regular.ttf", { family: "Patrick Hand" }],
  ["Pacifico-Regular.ttf", { family: "Pacifico" }],
];
for (const [file, desc] of FACES) {
  const p = path.join(DIR, file);
  if (fs.existsSync(p)) { try { registerFont(p, desc); } catch { /* keep going with system fonts */ } }
}

/** Named styles usable by text/label jobs: { family, weight, sizeFactor, lineHeight, caps } */
const STYLES = {
  sans:        { family: "Liberation Sans", weight: "", lineHeight: 1.25 },
  serif:       { family: "Liberation Serif", weight: "", lineHeight: 1.3 },
  mono:        { family: "Liberation Mono", weight: "", lineHeight: 1.25 },
  display:     { family: "Bebas Neue", weight: "", lineHeight: 1.05, sizeFactor: 1.35, caps: true },
  marker:      { family: "Permanent Marker", weight: "", lineHeight: 1.3, sizeFactor: 1.1 },
  handwriting: { family: "Kalam", weight: "bold", lineHeight: 1.45, sizeFactor: 1.15 },
  casual:      { family: "Patrick Hand", weight: "", lineHeight: 1.35, sizeFactor: 1.2 },
  script:      { family: "Pacifico", weight: "", lineHeight: 1.6, sizeFactor: 1.0 },
};

function styleOf(name) {
  return STYLES[name] || STYLES.sans;
}
function fontString(style, px, bold = false) {
  const w = style.weight || (bold ? "bold" : "");
  return `${w ? w + " " : ""}${px}px "${style.family}"`;
}

module.exports = { STYLES, styleOf, fontString };
