import type { BrowserContext, Locator, Page } from "@playwright/test";
import { chatWorld, convoz, startSession, type AgentSession, type World } from "./chat.ts";
import type { ServerOptions, ServerHandle } from "./fixtures.ts";
import { signInBrowser } from "./machines.ts";
import { expect } from "./scenario.ts";

/**
 * Helpers for the phone chat UI scenarios (tests/chat-ui.spec.ts). The page contract is the comment block at the top of that file.
 * Locators are role, accessible name and text only, so the S-U React app can pass the same tests.
 */

export interface UiWorld {
  w: World;
  /** `convoz session start --as H` leases, by handle. */
  sessions: Record<string, AgentSession>;
}

/**
 * Background: a fresh server, owner "drew", the agents, machine "box-2", a live session for each handle in `live`, and the owner's
 * browser signed in. All API step-ups happen before the browser takes the passkey (its counter continues from there).
 * Streams are recorded so a scenario can cut them (see `dropStreams`).
 */
export async function uiWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext },
  o: { agents?: string[]; live?: string[] } = {},
): Promise<UiWorld> {
  const agents = o.agents ?? ["devtool", "docs"];
  const w = await chatWorld(fx.server, { agents });
  const sessions: Record<string, AgentSession> = {};
  for (const h of o.live ?? ["devtool"]) sessions[h] = await startSession(w.box, h, `ui-${h}`);
  await recordStreams(fx.context);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return { w, sessions };
}

// ---- recorded live streams (EventSource) ---------------------------------------------------------------

/** Keep every EventSource the page opens in `window.__es`, so a test can cut one without the page knowing, or push a frame into it. */
export async function recordStreams(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.EventSource;
    if (!Native) return;
    (window as any).__es = [];
    (window as any).EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        (window as any).__es.push(this);
      }
    };
  });
}

/** Close every live stream silently, the way iOS does in the background: no error event reaches the page. */
export async function dropStreams(page: Page): Promise<number> {
  return page.evaluate(() => {
    const all: EventSource[] = (window as any).__es ?? [];
    all.forEach((e) => e.close());
    return all.length;
  });
}

/** Deliver one named frame to the page's open stream(s), as if the server had sent it. */
export async function pushFrame(page: Page, event: string, data: unknown): Promise<void> {
  const n = await page.evaluate(
    ([ev, json]) => {
      const all: EventSource[] = ((window as any).__es ?? []).filter((e: EventSource) => e.readyState !== 2);
      all.forEach((e) => e.dispatchEvent(new MessageEvent(ev as string, { data: json as string })));
      return all.length;
    },
    [event, JSON.stringify(data)] as const,
  );
  if (n === 0) throw new Error("pushFrame: the page has no open EventSource");
}

/** Wait until the page has a live stream open, so a live-only frame sent now is not missed. */
export async function streamOpen(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ((window as any).__es ?? []).some((e: EventSource) => e.readyState === 1)), { message: "the page has an open stream" }).toBe(true);
}

/** Fire the events a phone fires when the app comes back: pageshow (persisted, bfcache), visibilitychange and online. */
export async function appReturns(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
  });
}

// ---- locators ------------------------------------------------------------------------------------------

export const mainNav = (page: Page): Locator => page.getByRole("navigation", { name: "Main" });
export const nowHeading = (page: Page): Locator => page.getByRole("heading", { name: "Now", exact: true });
/** The Conversations list heading (prototype v41 names the Chats list "Conversations"). */
export const chatsHeading = (page: Page): Locator => page.getByRole("heading", { name: "Conversations", exact: true });
/** "New conversation": the button that floats above the bar, and in the empty state also the link in the page body. */
export const newChat = (page: Page): Locator => page.getByRole("link", { name: "New conversation" }).first();
export const chatList = (page: Page): Locator => page.getByRole("list", { name: "Conversations" });
export const chatRow = (page: Page, title: string): Locator => chatList(page).getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
/** Titles in list order. */
export const rowTitles = (page: Page): Promise<string[]> => chatList(page).getByRole("heading").allTextContents();
/** The unread count pill of a row (prototype v41 has no dot): its text is "Unread: 3". */
export const unreadDot = (row: Locator): Locator => row.getByText(/^Unread: \d/);
export const messageLog = (page: Page): Locator => page.getByRole("log", { name: "Messages" });
/** A message in the open chat, found by text. */
export const message = (page: Page, text: string | RegExp): Locator => messageLog(page).getByRole("article").filter({ hasText: text });
export const composer = (page: Page): Locator => page.getByRole("textbox", { name: /^Message @/ });
export const sendButton = (page: Page): Locator => page.getByRole("button", { name: "Send", exact: true });
export const backButton = (page: Page): Locator => page.getByRole("link", { name: "Back", exact: true });
export const workingNote = (page: Page): Locator => page.getByRole("status").filter({ hasText: /(is|are) replying/ });
export const newMessagePill = (page: Page): Locator => page.getByRole("button", { name: "New message ↓" });

/** The agent button in the @ menu of New conversation (open it with `openMentions`). */
export const agentChoice = (page: Page, handle: string): Locator => page.getByRole("list", { name: "Agents" }).getByRole("button", { name: new RegExp(`@${handle}\\b`) });

// ---- measures ------------------------------------------------------------------------------------------

/** True when the element's text is bold (weight 600 or more). */
export const isBold = (l: Locator): Promise<boolean> => l.evaluate((e) => Number(getComputedStyle(e).fontWeight) >= 600);

/** Type "@" in the empty message box of New conversation: the prototype's menu of agents opens above it. */
export async function openMentions(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("@");
}

/** Bring an agent into a new conversation: type "@", then pick it from the menu. */
export async function chooseAgent(page: Page, handle: string): Promise<void> {
  await openMentions(page);
  await agentChoice(page, handle).click();
}

/** How far the log is from its bottom edge, in CSS px (0 = at the latest message). */
export const fromBottom = (log: Locator): Promise<number> => log.evaluate((e) => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight));

/** Does the bubble (an element) have a visible background? */
export const hasBubble = (l: Locator): Promise<boolean> =>
  l.evaluate((e) => {
    const c = getComputedStyle(e).backgroundColor;
    return c !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
  });

/** Visible tap targets of the chat pages that are shorter than 44 px: "tag name height". */
export function smallChatTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, [role="menuitem"], input:not([type="checkbox"]):not([type="radio"]), textarea, nav a, header a, main a, [role="list"] a';
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || e.closest("[hidden]") || e.closest("pre") || e.closest('[role="article"]')) continue;
      if (r.height < 43.5) out.push(`${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.height)}px`);
    }
    return out;
  });
}

// ---- the agent as a person at a shell ------------------------------------------------------------------

/** `convoz post --format markdown <conv> <text>` as `handle`. Returns stdout (the message id). */
export async function agentPosts(u: UiWorld, handle: string, conv: number, text: string): Promise<string> {
  const res = await convoz(u.w.box, u.sessions[handle]!.sid, ["post", "--format", "markdown", String(conv), text]);
  if (res.code !== 0) throw new Error(`convoz post as ${handle}: exit ${res.code}\n${res.stderr}`);
  return res.stdout;
}
