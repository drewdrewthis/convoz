// Side-by-side image (prototype | app | diff) and the share of differing pixels for each screen the parity spec kept.
//
//   PARITY_ACTUAL_DIR=<dir> pnpm e2e -- prototype-parity     # the spec writes the app shots into <dir>
//   node e2e/tools/compare-visual.mjs <dir>                   # writes e2e/visual/compare/<screen>-<scheme>.png, prints the diff %
//
// Pixels differ when their colour distance (pixelmatch's YIQ delta, threshold 0.2) is over the limit. The spec itself asserts with
// Playwright's toHaveScreenshot; this number is the same idea, for the report.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const here = import.meta.dirname;
const actualDir = process.argv[2];
if (!actualDir) throw new Error("usage: compare-visual.mjs <dir with the app shots>");
const refDir = path.join(here, "..", "visual", "prototype");
const outDir = path.join(here, "..", "visual", "compare");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
for (const file of fs.readdirSync(actualDir).filter((f) => f.endsWith(".png")).sort()) {
  const ref = path.join(refDir, file);
  if (!fs.existsSync(ref)) continue;
  const res = await page.evaluate(
    async ([a, b]) => {
      const load = (src) => new Promise((ok) => Object.assign(new Image(), { onload() { ok(this); }, src }));
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
      const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
      const A = px(ia), B = px(ib);
      const out = document.createElement("canvas");
      out.width = w * 3; out.height = h;
      const o = out.getContext("2d");
      o.drawImage(ib, 0, 0); o.drawImage(ia, w, 0);
      const D = o.createImageData(w, h);
      const max = 35215 * 0.2 * 0.2;
      let bad = 0;
      for (let i = 0; i < w * h * 4; i += 4) {
        const al = A.data[i + 3] / 255, bl = B.data[i + 3] / 255;
        const [r1, g1, b1] = [0, 1, 2].map((k) => 255 + (A.data[i + k] - 255) * al);
        const [r2, g2, b2] = [0, 1, 2].map((k) => 255 + (B.data[i + k] - 255) * bl);
        const y = 0.29889531 * (r1 - r2) + 0.58662247 * (g1 - g2) + 0.11448223 * (b1 - b2);
        const iq = 0.59597799 * (r1 - r2) - 0.2741761 * (g1 - g2) - 0.32180189 * (b1 - b2);
        const q = 0.21147017 * (r1 - r2) - 0.52261711 * (g1 - g2) + 0.31114694 * (b1 - b2);
        const d = 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
        const hit = d > max;
        if (hit) bad++;
        D.data[i] = hit ? 255 : 235; D.data[i + 1] = hit ? 0 : 235; D.data[i + 2] = hit ? 80 : 235; D.data[i + 3] = 255;
      }
      o.putImageData(D, w * 2, 0);
      return { bad, total: w * h, png: out.toDataURL("image/png"), size: [ia.width, ia.height, ib.width, ib.height] };
    },
    [b64(path.join(actualDir, file)), b64(ref)],
  );
  fs.writeFileSync(path.join(outDir, file.replace(/\.png$/, "-side-by-side.png")), Buffer.from(res.png.split(",")[1], "base64"));
  console.log(`${file.replace(/\.png$/, "").padEnd(28)} ${(100 * res.bad / res.total).toFixed(2)}% differ   (app ${res.size[0]}x${res.size[1]}, prototype ${res.size[2]}x${res.size[3]})`);
}
await browser.close();
