import type { BrowserContext, Locator, Page } from "@playwright/test";
import { convoz, createConversation, startSession, type Owner } from "./chat.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { addSecondPasskey, signInWith } from "./mobile.ts";
import { must } from "./owner.ts";
import type { SoftAuthenticator } from "./soft-authenticator.ts";
import { browserWorld, world } from "./wp3.ts";

/**
 * Helpers of the rail, stars, pins and mute scenarios (rail.wp9.spec.ts, pins-stars.wp9.spec.ts).
 *
 * THE PAGE the bindings rely on (locators are role, name and text only):
 *   At a viewport 900 px wide or more the signed-in app has a sidebar: navigation "Conversations" with the buttons Search, Back, Forward,
 *   the link "New conversation", Now, and the groups (role group) "Starred", "Conversations" and "Older". A row is a link named like the
 *   conversation (", N unread" after it when unread) with the title text in .rtitle; its star is the button "Star conversation <title>" /
 *   "Unstar conversation <title>" and its grip the button "Reorder <title>. Alt plus arrow keys move it.". "Older · N" is a button
 *   (aria-expanded) that shows the group's rows. Below 900 px the phone UI has no sidebar.
 *   GET /api/conversations rows carry starred, rank (coalesce(rail_rank, created_at)) and muted_until (only when muted).
 *   PATCH /api/conversations/:id/prefs {starred?, muted_until?, place?:{after}} answers {conversation_id, starred, muted_until, ranks}.
 */

export const TITLES = ["Ship search filters", "Deploy alerts runbook", "Weekly usage"] as const;

export interface RailWorld {
  w: Awaited<ReturnType<typeof browserWorld>>;
  /** Conversation ids by number: 41, 52, 60 (the titles' order of creation). */
  c: { 41: number; 52: number; 60: number };
  /** The owner's second device. */
  second: SoftAuthenticator;
}

/**
 * Background: a fresh server, owner "drew" with two passkeys (the first is in `page`, the second for a second browser), machine "box-2" with
 * allow-list "devtool", and conversations 41, 52 and 60 created in that order with "devtool". The server runs with the plain data file.
 */
export async function railWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext },
  o: { create?: boolean } = {},
): Promise<RailWorld> {
  let second!: SoftAuthenticator;
  const w = await browserWorld(fx, { agents: ["devtool", "docs"], live: ["devtool"], plaintext: true, beforeSignIn: async (x) => void (second = await addSecondPasskey(x.srv, x.owner)) });
  const ids: number[] = [];
  if (o.create !== false) for (const title of TITLES) ids.push(await createConversation(w.owner, { participants: ["devtool"], title }));
  return { w, c: { 41: ids[0]!, 52: ids[1]!, 60: ids[2]! }, second };
}

/** The same Background without a browser, for the @api scenarios. */
export async function apiRailWorld(server: (o?: ServerOptions) => Promise<ServerHandle>) {
  const w = await world(server, { agents: ["devtool", "docs"], plaintext: true });
  const sessions = { devtool: await startSession(w.box, "devtool", "api-devtool"), docs: await startSession(w.box, "docs", "api-docs") };
  const ids: number[] = [];
  for (const title of TITLES) ids.push(await createConversation(w.owner, { participants: ["devtool", "docs"], title }));
  return { w: { ...w, sessions }, c: { 41: ids[0]!, 52: ids[1]!, 60: ids[2]! } };
}

/**
 * The rail is the desktop sidebar, so every rail scenario looks at a desktop-wide window. In the "mobile" project (390 px, touch) the
 * window is widened first; on the desktop project this changes nothing.
 */
export const desktopWindow = (page: Page): Promise<void> => page.setViewportSize({ width: 1280, height: 800 });

export const rail = (page: Page): Locator => page.getByRole("navigation", { name: "Conversations" });
export const railGroup = (page: Page, name: "Starred" | "Conversations" | "Older"): Locator => rail(page).getByRole("group", { name });

/** The titles of one group, top to bottom. */
export const railTitles = (page: Page, name: "Starred" | "Conversations" | "Older"): Promise<string[]> => railGroup(page, name).locator(".rtitle").allTextContents();

/** The row of a conversation in the rail. */
export const railRow = (page: Page, title: string): Locator => rail(page).locator(".rrow").filter({ has: page.locator(".rtitle", { hasText: new RegExp(`^${title}$`) }) });

/** Open a page of the app at a desktop width and wait for the rail to show its rows. */
export async function openRail(page: Page, srv: ServerHandle, path = "/chats"): Promise<void> {
  await desktopWindow(page);
  await page.goto(`${srv.origin}${path}`);
  await rail(page).waitFor();
}

/** The owner's PATCH /api/conversations/:id/prefs, as the page sends it. The raw answer. */
export const patchPrefs = (owner: Owner, conv: number, body: unknown) => owner.client.request("PATCH", `/api/conversations/${conv}/prefs`, { csrf: true, json: body });

/** The same, and it must answer 200. */
export async function setPrefs(owner: Owner, conv: number, body: unknown) {
  return must(await patchPrefs(owner, conv, body), `prefs of ${conv}`).json();
}

export interface RailRowJson {
  id: number;
  title: string;
  created_at: number;
  last_activity_at: number;
  starred: boolean;
  rank: number;
  muted_until?: number;
  unread: number;
}

/** GET /api/conversations as the owner. */
export async function railRows(owner: Owner): Promise<RailRowJson[]> {
  return must(await owner.client.get("/api/conversations"), "list conversations").json().conversations as RailRowJson[];
}

/** The ids of one section of the owner's rail in the owner's order (rank, then id, both highest first). */
export async function sectionOrder(owner: Owner, starred: boolean): Promise<number[]> {
  return (await railRows(owner))
    .filter((c) => c.starred === starred)
    .sort((a, b) => b.rank - a.rank || b.id - a.id)
    .map((c) => c.id);
}

/** `convoz post` as an agent session. */
export async function agentSays(w: RailWorld["w"], handle: string, conv: number, text: string): Promise<void> {
  const res = await convoz(w.box, w.sessions[handle]!.sid, ["post", "--format", "markdown", String(conv), text]);
  if (res.code !== 0) throw new Error(`convoz post as ${handle}: exit ${res.code}\n${res.stderr}`);
}

/** Drag a rail row with the mouse until its middle is at `y`, in small steps so the page sees a drag. */
export async function dragTo(page: Page, row: Locator, y: number): Promise<void> {
  const box = (await row.boundingBox())!;
  const x = box.x + 40;
  const from = box.y + box.height / 2;
  await page.mouse.move(x, from);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, from + ((y - from) * i) / 8);
  await page.mouse.up();
}

/** The y between two rows of the rail (the gap a dragged row is dropped into). */
export async function between(above: Locator, below: Locator): Promise<number> {
  const a = (await above.boundingBox())!;
  const b = (await below.boundingBox())!;
  return (a.y + a.height + b.y) / 2;
}

export { signInWith };
