// Bundled open fonts (OFL / Apache, see fonts/), registered with node-canvas so
// prints look the same on every machine. Must be required before any canvas
// is created (render.cjs and charts.cjs do so at load time).
const path = require("path");
const fs = require("fs");
const { registerFont } = require("canvas");

const DIR = path.join(__dirname, "..", "fonts");
const FACES = [
  // handwriting / casual
  ["PermanentMarker-Regular.ttf", { family: "Permanent Marker" }],
  ["Kalam-Bold.ttf", { family: "Kalam", weight: "bold" }],
  ["PatrickHand-Regular.ttf", { family: "Patrick Hand" }],
  ["Pacifico-Regular.ttf", { family: "Pacifico" }],
  ["Lobster-Regular.ttf", { family: "Lobster" }],
  // professional
  ["Poppins-Regular.ttf", { family: "Poppins" }],
  ["Poppins-Bold.ttf", { family: "Poppins", weight: "bold" }],
  ["LibreBaskerville-Variable.ttf", { family: "Libre Baskerville" }],
  ["EBGaramond-Variable.ttf", { family: "EB Garamond" }],
  ["PlayfairDisplay-Variable.ttf", { family: "Playfair Display" }],
  ["Cinzel-Variable.ttf", { family: "Cinzel" }],
  // display / creative
  ["BebasNeue-Regular.ttf", { family: "Bebas Neue" }],
  ["Anton-Regular.ttf", { family: "Anton" }],
  ["AlfaSlabOne-Regular.ttf", { family: "Alfa Slab One" }],
  ["AbrilFatface-Regular.ttf", { family: "Abril Fatface" }],
  ["YesevaOne-Regular.ttf", { family: "Yeseva One" }],
  ["Righteous-Regular.ttf", { family: "Righteous" }],
  ["Bangers-Regular.ttf", { family: "Bangers" }],
  ["Rye-Regular.ttf", { family: "Rye" }],
  ["SpecialElite-Regular.ttf", { family: "Special Elite" }],
];
for (const [file, desc] of FACES) {
  const p = path.join(DIR, file);
  if (fs.existsSync(p)) { try { registerFont(p, desc); } catch { /* keep going with system fonts */ } }
}

/** Named styles usable by text/label jobs: { family, weight, sizeFactor, lineHeight, caps } */
const STYLES = {
  // plain
  sans:        { family: "Liberation Sans", weight: "", lineHeight: 1.25, group: "plain", label: "Sans" },
  serif:       { family: "Liberation Serif", weight: "", lineHeight: 1.3, group: "plain", label: "Serif" },
  mono:        { family: "Liberation Mono", weight: "", lineHeight: 1.25, group: "plain", label: "Monospace" },
  // professional
  modern:      { family: "Poppins", weight: "bold", lineHeight: 1.3, group: "professional", label: "Modern (Poppins Bold)" },
  clean:       { family: "Poppins", weight: "", lineHeight: 1.35, group: "professional", label: "Clean (Poppins)" },
  classic:     { family: "Libre Baskerville", weight: "", lineHeight: 1.4, group: "professional", label: "Classic (Baskerville)" },
  garamond:    { family: "EB Garamond", weight: "", lineHeight: 1.35, sizeFactor: 1.1, group: "professional", label: "Book (Garamond)" },
  elegant:     { family: "Playfair Display", weight: "", lineHeight: 1.3, group: "professional", label: "Elegant (Playfair)" },
  roman:       { family: "Cinzel", weight: "", lineHeight: 1.3, caps: true, group: "professional", label: "Roman caps (Cinzel)" },
  // display / creative
  display:     { family: "Bebas Neue", weight: "", lineHeight: 1.05, sizeFactor: 1.35, caps: true, group: "display", label: "Display (Bebas Neue)" },
  impact:      { family: "Anton", weight: "", lineHeight: 1.1, sizeFactor: 1.3, caps: true, group: "display", label: "Impact (Anton)" },
  slab:        { family: "Alfa Slab One", weight: "", lineHeight: 1.25, group: "display", label: "Slab (Alfa Slab One)" },
  fatface:     { family: "Abril Fatface", weight: "", lineHeight: 1.2, sizeFactor: 1.15, group: "display", label: "Fatface (Abril)" },
  vintage:     { family: "Yeseva One", weight: "", lineHeight: 1.25, sizeFactor: 1.1, group: "display", label: "Vintage (Yeseva One)" },
  retro:       { family: "Righteous", weight: "", lineHeight: 1.25, sizeFactor: 1.1, group: "display", label: "Retro (Righteous)" },
  comic:       { family: "Bangers", weight: "", lineHeight: 1.15, sizeFactor: 1.3, caps: true, group: "display", label: "Comic (Bangers)" },
  western:     { family: "Rye", weight: "", lineHeight: 1.3, group: "display", label: "Western (Rye)" },
  typewriter:  { family: "Special Elite", weight: "", lineHeight: 1.35, group: "display", label: "Typewriter (Special Elite)" },
  // handwriting / script
  marker:      { family: "Permanent Marker", weight: "", lineHeight: 1.3, sizeFactor: 1.1, group: "hand", label: "Marker" },
  handwriting: { family: "Kalam", weight: "bold", lineHeight: 1.45, sizeFactor: 1.15, group: "hand", label: "Handwriting (Kalam)" },
  casual:      { family: "Patrick Hand", weight: "", lineHeight: 1.35, sizeFactor: 1.2, group: "hand", label: "Casual hand (Patrick Hand)" },
  script:      { family: "Pacifico", weight: "", lineHeight: 1.6, group: "hand", label: "Script (Pacifico)" },
  lobster:     { family: "Lobster", weight: "", lineHeight: 1.35, sizeFactor: 1.15, group: "hand", label: "Bold script (Lobster)" },
};
const STYLE_NAMES = Object.keys(STYLES);

function styleOf(name) {
  return STYLES[name] || STYLES.sans;
}
function fontString(style, px, bold = false) {
  const w = style.weight || (bold ? "bold" : "");
  return `${w ? w + " " : ""}${px}px "${style.family}"`;
}

module.exports = { STYLES, STYLE_NAMES, styleOf, fontString };
