// Renders the v42 prototype phone frame (Iris, light and dark) and writes the reference PNGs the parity scenarios compare against.
//
//   PROTOTYPE_HTML=/path/to/index.html node e2e/tools/capture-prototype.mjs [outDir]
//
// The frame's border and radius are neutralised so the PNG is exactly 390x800 CSS px (2x). Rectangles from visual/masks.json are
// painted over the frame; the parity spec paints the same rectangles over the app, so the controls the app does not have yet
// (and the times) never count. Run it from e2e/ so @playwright/test resolves.
//
// Besides the phone frame (390x800) it shoots one desktop element at a 1280x800 window: the rail (the sidebar, 240x742, "rail-desktop").
// Masks of a desktop screen are relative to its element, like the phone's are to the frame. Now with asks, Crew and Crew with agent
// status are not captured: the owner changed them on purpose, so they are compared with reviewed frames of the app in visual/app/.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const here = import.meta.dirname;
const html = process.env.PROTOTYPE_HTML ?? "/tmp/tmp.Trpsi82Qzz/index.html";
const out = process.argv[2] ?? path.join(here, "..", "visual", "prototype");
const masks = JSON.parse(fs.readFileSync(path.join(here, "..", "visual", "masks.json"), "utf8"));
const SCALE = 2;
const FRAME = "div[style*='border-radius: 40px'][style*='width: 390px']";

const browser = await chromium.launch();
for (const mode of ["Light", "Dark"]) {
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: SCALE });
    await page.goto(`file://${html}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Phone", exact: true }).click();
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(400);
    const dismiss = page.getByRole("button", { name: "Dismiss notification" });
    if (await dismiss.count()) await dismiss.first().click();
    await page.addStyleTag({ content: "*,*::before,*::after{caret-color:transparent!important;animation:none!important;transition:none!important}" });
    await page.locator(FRAME).first().evaluate((el) => el.setAttribute("data-frame", "1")); // the style match stops holding once the border is gone
    const frame = page.locator("[data-frame]");
    const shot = async (name) => {
      await page.mouse.move(0, 0); // no hover state on a row
      await page.waitForTimeout(500);
      await frame.evaluate((el, rects) => {
        el.style.border = "0";
        el.style.borderRadius = "0";
        for (const r of rects) {
          const d = document.createElement("div");
          d.setAttribute("data-mask", r.name);
          d.style.cssText = `position:absolute;z-index:9999;background:#808080;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
          el.appendChild(d);
        }
      }, masks[name] ?? []);
      const box = await frame.boundingBox();
      if (process.env.PROBE && mode === "Light") {
        // PROBE=1 prints the frame-relative box of every control, heading and time label: the numbers masks.json is written from.
        const rows = await frame.evaluate((el) => {
          const f = el.getBoundingClientRect();
          const out = [];
          for (const n of el.querySelectorAll("button,input,h1,h2,h3,li,span")) {
            const r = n.getBoundingClientRect();
            const label = n.getAttribute("aria-label") || (n.tagName === "SPAN" ? n.textContent.trim() : n.tagName.toLowerCase());
            if (n.tagName === "SPAN" && !/^\d+:\d\d [AP]M$|^\d+ asks?$/.test(label) && n.children.length) continue;
            if (n.tagName === "SPAN" && !/^\d+:\d\d [AP]M$|^\d+ asks?$|^[\w-]+$|Idle|Waiting/.test(label)) continue;
            if (r.width && r.height) out.push(`${n.tagName.toLowerCase()} ${JSON.stringify(label.slice(0, 40))} x=${Math.round(r.x - f.x)} y=${Math.round(r.y - f.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
          }
          return out;
        });
        console.log(`--- ${name}\n${rows.join("\n")}`);
      }
      if (Math.round(box.width) !== 390 || Math.round(box.height) !== 800) throw new Error(`frame is ${box.width}x${box.height}, want 390x800`);
      await frame.screenshot({ path: path.join(out, `${name}-${mode.toLowerCase()}.png`) });
      await frame.evaluate((el) => el.querySelectorAll("[data-mask]").forEach((d) => d.remove()));
    };
    return { page, frame, tabs: frame.getByRole("navigation", { name: "Main" }), shot };
  };

  // Now: answer every ask so the feed is empty.
  {
    const { page, frame, shot } = await open();
    for (let i = 0; i < 30 && !(await frame.getByText("All clear. Nothing needs you.").count()); i++) {
      await frame.locator("ul[aria-label='Open asks'] li").first().locator("button").nth(1).click();
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(10500); // the toast stays 10 s
    await shot("now");
    await page.close();
  }

  // The rail on a phone: the Conversations tab as the prototype has it, with its Starred group and its muted "Team updates".
  {
    const { page, frame, tabs, shot } = await open();
    await tabs.getByRole("button", { name: "Conversations" }).click();
    await page.waitForTimeout(500);
    await shot("rail");
    await page.close();
  }

  const { page, frame, tabs, shot } = await open();
  // The app has no stars: take the two starred conversations out of Starred (opening one reads it) so the list is one "Conversations" section.
  await tabs.getByRole("button", { name: "Conversations" }).click();
  for (const title of ["Ops reports", "assistant"]) {
    await frame.locator("li button").filter({ hasText: title }).first().click();
    await frame.getByRole("button", { name: "Unstar conversation" }).click();
    await frame.getByRole("button", { name: "Back" }).first().click();
  }
  await tabs.getByRole("button", { name: "Now" }).click(); // a new step drops the Forward arrow
  await tabs.getByRole("button", { name: "Conversations" }).click();
  await page.waitForTimeout(10500);
  await shot("conversations");

  // A plain thread: an owner message, an agent reply with bold text and a list. No prototype thread is free of asks, attachments and
  // previews except this one, and it has one agent message only.
  await frame.locator("li button").filter({ hasText: "Why did the nightly export get slower?" }).first().click();
  // Nothing claims conversations (owner, 2026-10: "Nothing claims conversations"): drop the "picked this up" line under the owner's message,
  // avatar and all. The prototype still draws it.
  await frame.evaluate((el) => el.querySelectorAll("span").forEach((n) => n.isConnected && n.textContent.trim().endsWith("lane-search picked this up") && n.remove()));
  await frame.locator("[role=log]").evaluate((e) => (e.scrollTop = 0));
  await shot("conversation-thread");
  await frame.getByRole("button", { name: "Back" }).first().click();

  // A thread: the sheet that opens from the reply line under night-watch's "Deploy finished" in Ops reports (3 replies).
  await frame.locator("li button").filter({ hasText: "Ops reports" }).first().click();
  await frame.getByRole("button", { name: /^Open thread, 3 replies/ }).click();
  await shot("thread");
  await frame.getByRole("dialog", { name: /^Thread / }).getByRole("button", { name: "Back" }).click(); // closes the sheet
  await frame.getByRole("button", { name: "Back" }).first().click(); // and leaves the conversation

  await frame.getByRole("button", { name: "New conversation" }).first().click();
  await shot("new-conversation");
  await frame.getByRole("button", { name: "Back" }).first().click();

  await page.close();
}

// Desktop: the rail sidebar and the Crew dock, as elements of the 1280x800 window.
for (const mode of ["Light", "Dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SCALE });
  await page.goto(`file://${html}`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page.waitForTimeout(400);
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismiss.count()) await dismiss.first().click();
  await page.addStyleTag({ content: "*,*::before,*::after{caret-color:transparent!important;animation:none!important;transition:none!important}" });
  const desktopShot = async (name, el, w, h) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await el.evaluate((node, rects) => {
      if (getComputedStyle(node).position === "static") node.style.position = "relative";
      for (const r of rects) {
        const d = document.createElement("div");
        d.setAttribute("data-mask", r.name);
        d.style.cssText = `position:absolute;z-index:9999;background:#808080;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
        node.appendChild(d);
      }
    }, masks[name] ?? []);
    const box = await el.boundingBox();
    if (Math.round(box.width) !== w || Math.round(box.height) !== h) throw new Error(`${name} is ${box.width}x${box.height}, want ${w}x${h}`);
    await el.screenshot({ path: path.join(out, `${name}-${mode.toLowerCase()}.png`) });
    await el.evaluate((node) => node.querySelectorAll("[data-mask]").forEach((d) => d.remove()));
  };
  await desktopShot("rail-desktop", page.getByRole("navigation", { name: "Conversations" }), 240, 742);
  await page.close();
}
await browser.close();
