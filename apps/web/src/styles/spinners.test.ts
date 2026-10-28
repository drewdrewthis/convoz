import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// A desktop that sets "reduce motion" showed the working ring still, where the phone showed it turning: the global rule that stops
// every animation also stopped the spinners. They keep turning there, slowly.
const css = fs.readFileSync(new URL("./app.css", import.meta.url), "utf8");
const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
const block = reduced.slice(0, reduced.indexOf("/* ---- Conversations"));

test("under reduced motion the working spinners keep turning", () => {
  assert.match(block, /\.working::before \{ animation: workspin [\d.]+s linear infinite !important; \}/);
  assert.match(block, /\.pdot\[data-tone="green"\], \.planicon \.spin \{ animation: pdotspin [\d.]+s linear infinite !important; \}/);
  assert.match(block, /\.ring\[data-st="working"\]::before \{ animation: ringspin [\d.]+s linear infinite !important; \}/);
});

test("no other rule stops the spinners", () => {
  for (const f of ["../features/conversations/conversations.css", "../features/crew/crew.css"]) {
    const t = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(t, /prefers-reduced-motion[^\n]*(pdot|spin|ring)/);
  }
});
