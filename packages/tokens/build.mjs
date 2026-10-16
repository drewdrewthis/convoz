// Reads the DTCG palettes in src/, writes dist/tokens.css and prints a contrast
// report. Exits 1 when any text pair is below 4.5:1 (WCAG AA, design §14).
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const srcDir = path.join(here, "src");
const distDir = path.join(here, "dist");
const MIN_RATIO = 4.5;

// Each palette lists its own text tokens in `$textTokens`; each is checked on every surface.
// A listed token that a theme lacks is a failure, never a silent skip.
const SURFACES = ["bg", "surface", "raised"];
const EXTRA_PAIRS = [["onAccent", "accent"]];

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const pairsFor = (textTokens) => [
  ...textTokens.flatMap((t) => SURFACES.map((s) => [t, s])),
  ...EXTRA_PAIRS,
];

let failures = 0;
const css = [];
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".tokens.json")).sort();
for (const file of files) {
  const palette = file.replace(".tokens.json", "");
  const doc = JSON.parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
  const textTokens = doc.$textTokens;
  if (!Array.isArray(textTokens) || textTokens.length === 0) {
    failures++;
    console.log(`  FAIL ${palette}: no $textTokens list`);
    continue;
  }
  for (const mode of ["light", "dark"]) {
    const colors = Object.fromEntries(Object.entries(doc[mode].color).map(([k, v]) => [k, v.$value]));
    css.push(`[data-palette="${palette}"][data-theme="${mode}"] {`);
    for (const [k, v] of Object.entries(colors)) css.push(`  --cv-${k}: ${v};`);
    css.push("}");
    console.log(`contrast ${palette} ${mode}`);
    for (const [fg, bg] of pairsFor(textTokens)) {
      const missing = [fg, bg].filter((t) => !colors[t]);
      if (missing.length) {
        failures++;
        console.log(`  FAIL ${fg} on ${bg}: missing token ${missing.join(", ")}`);
        continue;
      }
      const ratio = contrast(colors[fg], colors[bg]);
      const ok = ratio >= MIN_RATIO;
      if (!ok) failures++;
      console.log(`  ${ok ? "ok  " : "FAIL"} ${fg} on ${bg} ${ratio.toFixed(2)}:1`);
    }
  }
}
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "tokens.css"), css.join("\n") + "\n");
console.log(failures ? `contrast: ${failures} pair(s) below ${MIN_RATIO}:1` : `contrast: every pair meets ${MIN_RATIO}:1`);
process.exit(failures ? 1 : 0);
