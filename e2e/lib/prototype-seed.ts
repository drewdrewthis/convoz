import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { agentPost, chatWorld, createConversation, ownerReads, ownerSays, startSession } from "./chat.ts";
import type { AgentSession } from "./chat.ts";
import { addSecondPasskey } from "./mobile.ts";
import { signInBrowser, stepped } from "./machines.ts";
import type { Owner } from "./owner.ts";
import type { BrowserContext } from "@playwright/test";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { must } from "./owner.ts";
import type { UiWorld } from "./chat-ui.ts";

/**
 * The prototype's sample data (v41, Iris), as far as the server can hold it: the same agents, conversation titles, previews and
 * unread counts, in the order the prototype lists them. Stars, mutes, asks, apps and agent statuses have no backend, so they are not
 * seeded; the parity scenarios mask what they would draw (visual/masks.json).
 */

/** Every agent the prototype names, in its order. */
export const AGENTS = ["assistant", "devtool", "orchardist", "night-watch", "usage-bot", "lane-search", "release-bot", "scrum-master", "docs", "triage"];

/**
 * uiWorld for the parity scenarios: the owner has two passkeys, so Now has no "add a second way in" note (the prototype has none), and
 * the browser signs in last (see uiWorld).
 */
export async function protoWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext },
  o: { agents: string[]; live: string[]; disabled?: string[] },
): Promise<UiWorld> {
  const w = await chatWorld(fx.server, { agents: o.agents });
  // A disabled agent still counts in the registry order that tints the avatars; it is not listed on Crew.
  for (const h of o.disabled ?? []) {
    const row = await findAgent(w.owner, h);
    must(await stepped(w.owner, "POST", `/api/identities/${row}/disable`, {}, "identity.disable", row), `disable ${h}`);
  }
  const sessions: Record<string, AgentSession> = {};
  for (const h of o.live) sessions[h] = await startSession(w.box, h, `ui-${h}`);
  await addSecondPasskey(w.srv, w.owner);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return { w, sessions };
}

async function findAgent(owner: Owner, handle: string): Promise<number> {
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { id: number; handle: string }[];
  return list.find((p) => p.handle === handle)!.id;
}

/** The agents the prototype's Crew lists as Idle once nobody is waiting or working (the app has no agent status), in its order. */
export const IDLE = ["orchardist", "usage-bot", "release-bot", "scrum-master", "triage"];
/** The others: made first-class in the registry so every agent keeps its place and tint, then disabled so Crew lists only the idle ones. */
export const NOT_IDLE = AGENTS.filter((h) => !IDLE.includes(h));
/** The two idle agents that are online: their line reads "Idle · Online and ready", as in the prototype. */
export const ONLINE_IDLE = ["orchardist", "release-bot"];

/** The agents that post, so each needs a live session. */
export const LIVE = ["assistant", "devtool", "night-watch", "usage-bot", "lane-search", "release-bot", "scrum-master"];

interface Chat {
  title: string;
  agents: string[];
  /** The author of every message. */
  from: string;
  /** Messages, oldest first. The last one is the preview. */
  say: string[];
  /** How many of the last messages are unread (0: the owner read them all). */
  unread: number;
  format?: "markdown";
  /** The owner says this first. */
  owner?: string;
}

/** Top of the list first. The first two are starred in the prototype; the app has no stars, so they are two read chats here. */
const LIST: Chat[] = [
  { title: "assistant", agents: ["assistant"], from: "assistant", say: ["Thursday morning is free after standup. The filters demo fits at 10:00."], unread: 0 },
  { title: "Ops reports", agents: ["night-watch", "usage-bot"], from: "night-watch", say: ["Full deploy log is attached."], unread: 0 },
  {
    title: "Bug #8642 · null check fix",
    agents: ["devtool"],
    from: "devtool",
    say: ["Picked up **bug 8642**. Reproducing it now (build 3.2-rc1).", "I reproduced it twice. The fix is a one-line null check; the new test fails before it and passes after."],
    unread: 2,
    format: "markdown",
  },
  {
    title: "Issue #100 · agent chat",
    agents: ["devtool"],
    from: "devtool",
    say: ["Read the issue.", "The feed CLI is the first slice.", "Server tables are in.", "The API answers.", "Tests are red where they should be.", "@devtool wants to add @night-watch"],
    unread: 6,
  },
  {
    title: "lane-search",
    agents: ["lane-search"],
    from: "lane-search",
    say: ["Starting step 1.", "Chips map to query parameters.", "URL state is next.", "Design notes for the filters are here: https://docs.acme.dev/search/filters"],
    unread: 4,
  },
  { title: "Team updates", agents: ["assistant", "release-bot", "lane-search"], from: "release-bot", say: ["Retry budget is up for review: https://github.com/acme/agents/pull/412"], unread: 0 },
  { title: "usage-bot", agents: ["usage-bot"], from: "usage-bot", say: ["Weekly spend is in.", "The docs lane used about half of today's tokens, mostly on long retrieval runs."], unread: 2 },
  {
    title: "scrum-master",
    agents: ["scrum-master"],
    from: "scrum-master",
    say: ["Two candidates for next sprint. Search filters unblock two lanes; the flaky tests cost about 40 minutes of CI a day."],
    unread: 1,
  },
  {
    title: "Why did the nightly export get slower?",
    agents: ["lane-search"],
    from: "lane-search",
    owner: "Why did the nightly export get slower last week?",
    say: ["It started after the **cache-headers change** on the 8th. Two things changed:\n\n- The export skips the warm cache now.\n- Each run re-reads every shard.\n\n#415 fixes both."],
    unread: 0,
    format: "markdown",
  },
  { title: "night-watch", agents: ["night-watch"], from: "night-watch", say: ["Nightly backup verified. Nothing for you to do."], unread: 0 },
];

/** Create the prototype's conversations (oldest activity first, so the list reads top to bottom as in the prototype). Returns id by title. */
export async function seedPrototype(u: UiWorld): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const chat of [...LIST].reverse()) {
    const conv = await createConversation(u.w.owner, { participants: chat.agents, title: chat.title });
    ids[chat.title] = conv;
    let last = 0;
    if (chat.owner) last = await ownerSays(u.w.owner, conv, chat.owner);
    for (const body of chat.say) {
      const res = await agentPost(u.w.srv, u.sessions[chat.from]!.lease, conv, body, chat.format ? { format: chat.format } : {});
      last = must(res, `${chat.from} posts in ${chat.title}`, 201).json().id as number;
    }
    if (chat.unread === 0) await ownerReads(u.w.owner, conv, last);
    else if (chat.unread < chat.say.length) await ownerReads(u.w.owner, conv, last - chat.unread);
  }
  return ids;
}

// ---- masks and the comparison -----------------------------------------------------------------------

export interface Rect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const here = import.meta.dirname;
export const MASKS: Record<string, Rect[]> = JSON.parse(fs.readFileSync(path.join(here, "..", "visual", "masks.json"), "utf8"));

/** The page the way the prototype frame is shot: 390x800, a colour scheme, fonts loaded, then the same grey boxes over the omitted controls and the times. */
export async function readyForShot(page: Page, screen: string, scheme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((rects) => {
    document.querySelectorAll("[data-mask]").forEach((d) => d.remove());
    for (const r of rects) {
      const d = document.createElement("div");
      d.setAttribute("data-mask", r.name);
      d.style.cssText = `position:fixed;z-index:2147483647;background:#808080;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      document.body.appendChild(d);
    }
  }, MASKS[screen] ?? []);
}

/** With PARITY_ACTUAL_DIR set, also write the app shot there (tools/compare-visual.mjs turns it into a side-by-side image). */
export async function keepActual(page: Page, name: string): Promise<void> {
  if (process.env.PARITY_PROBE && name.endsWith("-light")) {
    // The same boxes tools/capture-prototype.mjs prints for the prototype (PROBE=1), to line the two up.
    const rows = await page.evaluate(() => {
      const out: string[] = [];
      for (const n of document.querySelectorAll("button,input,textarea,h1,h2,h3,a,time,.preview,.count")) {
        const r = n.getBoundingClientRect();
        const label = n.getAttribute("aria-label") || (n.textContent ?? "").trim().slice(0, 30) || n.tagName.toLowerCase();
        if (r.width && r.height) out.push(`${n.tagName.toLowerCase()} ${JSON.stringify(label)} x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
      }
      return out;
    });
    console.log(`--- ${name}\n${rows.join("\n")}`);
  }
  const dir = process.env.PARITY_ACTUAL_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), animations: "disabled", caret: "hide", scale: "device" });
}

/** The share of the 390x800 frame that the grey boxes of a screen cover (overlaps counted once), in percent. */
export function maskPercent(screen: string): number {
  const covered = new Set<number>();
  for (const r of MASKS[screen] ?? [])
    for (let x = r.x; x < Math.min(390, r.x + r.w); x++) for (let y = r.y; y < Math.min(800, r.y + r.h); y++) covered.add(y * 390 + x);
  return (100 * covered.size) / (390 * 800);
}
