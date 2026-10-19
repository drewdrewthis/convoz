import type { BrowserContext, Locator, Page } from "@playwright/test";
import { agentPost, createConversation, startSession, unreadOf } from "./chat.ts";
import { chatRow, isBold, message, unreadDot } from "./chat-ui.ts";
import type { ServerOptions } from "./fixtures.ts";
import { clientId } from "./machines.ts";
import { must, type Owner } from "./owner.ts";
import { browserWorld, world, type World } from "./wp3.ts";

/**
 * Helpers for the thread scenarios of WP5 (tests/threads.wp5.spec.ts). The page contract is the block at the top of that file.
 * Locators are role, accessible name and text only.
 */

export const TITLE = "Ship search filters";
export const ROOT_TEXT = "Step 1 is the filter chips UI";

type Fx = { server: (o?: ServerOptions) => Promise<import("./fixtures.ts").ServerHandle>; page: Page; context: BrowserContext };

export interface ThreadWorld {
  w: World;
  /** Conversation 41 "Ship search filters" with "devtool" and "docs". */
  conv: number;
  /** Message 900: the root "devtool" posted. */
  root: number;
  /** The leases of "devtool" and "docs", and the local session ids the `convoz` CLI takes. */
  dev: string;
  docs: string;
  devSid: string;
  docsSid: string;
}

/**
 * Background: a fresh server with owner "drew", machine "box-2" with "devtool" and "docs", conversation 41 with both, and "devtool"'s
 * message 900. With `browser` the owner's browser is signed in too.
 */
export async function threadWorld(fx: Partial<Fx> & Pick<Fx, "server">, o: { browser?: boolean; agents?: string[] } = {}): Promise<ThreadWorld> {
  const agents = o.agents ?? ["devtool", "docs"];
  const w = o.browser ? await browserWorld(fx as Fx, { agents, plaintext: true }) : await world(fx.server, { agents, plaintext: true });
  const conv = await createConversation(w.owner, { participants: ["devtool", "docs"], title: TITLE });
  const devS = await startSession(w.box, "devtool", "dev");
  const docsS = await startSession(w.box, "docs", "docs");
  const root = Number(must(await agentPost(w.srv, devS.lease, conv, ROOT_TEXT), "devtool posts message 900", 201).json().id);
  return { w, conv, root, dev: devS.lease, docs: docsS.lease, devSid: devS.sid, docsSid: docsS.sid };
}

// ---- posting, over the API ----------------------------------------------------------------------------

/** A reply by an agent. Returns the message id. */
export async function agentReplies(t: ThreadWorld, lease: string, body: string, broadcast = false): Promise<number> {
  const res = await agentPost(t.w.srv, lease, t.conv, body, { thread_root_id: t.root, ...(broadcast ? { broadcast: true } : {}) });
  return Number(must(res, `reply ${JSON.stringify(body)}`, 201).json().id);
}

/** A reply by the owner (from "another device": the API client). Returns the message id. */
export async function ownerReplies(t: ThreadWorld, body: string, broadcast = false): Promise<number> {
  const res = await t.w.owner.client.post(`/api/conversations/${t.conv}/messages`, {
    client_id: clientId(),
    body,
    thread_root_id: t.root,
    ...(broadcast ? { broadcast: true } : {}),
  });
  return Number(must(res, `owner replies ${JSON.stringify(body)}`, 201).json().id);
}

/** The owner has read conversation 41: the main cursor at its newest main message. */
export async function ownerHasRead(t: ThreadWorld): Promise<void> {
  const page = must(await t.w.owner.client.get(`/api/conversations/${t.conv}/messages?limit=100`), "read the main list").json().messages as { id: number }[];
  must(await t.w.owner.client.post(`/api/conversations/${t.conv}/read`, { main_id: page[page.length - 1]!.id }), "owner reads");
}

/** The unread count the rail has for conversation 41 (`undefined` for none). */
export const unread = (t: ThreadWorld): Promise<number | undefined> => unreadOf(t.w.owner, t.conv);

/** The thread of message 900 as the owner reads it. */
export async function threadOf(owner: Owner, root: number): Promise<{ conversation_id: number; root: { id: number; body: string }; messages: { id: number; body: string; broadcast?: boolean }[] }> {
  return must(await owner.client.get(`/api/messages/${root}/replies`), "read the thread").json();
}

/** The main list as the owner reads it, newest page. */
export async function mainList(owner: Owner, conv: number): Promise<{ id: number; body: string; thread_root_id?: number; last_reply?: { id: number; author: { handle: string; kind: string }; preview: string; unread?: boolean } }[]> {
  return must(await owner.client.get(`/api/conversations/${conv}/messages?limit=100`), "read the main list").json().messages;
}

// ---- the thread pane ----------------------------------------------------------------------------------

/** The pane of the open thread: a full-screen sheet on a phone, a panel beside the chat on a wide screen. */
export const threadPane = (page: Page): Locator => page.getByRole("dialog", { name: /^Thread / }).or(page.getByRole("complementary", { name: /^Thread / }));
export const threadLog = (page: Page): Locator => threadPane(page).getByRole("log", { name: "Thread messages" });
export const replyBox = (page: Page): Locator => threadPane(page).getByRole("textbox", { name: "Reply in thread" });
export const sendReply = (page: Page): Locator => threadPane(page).getByRole("button", { name: "Send reply" });
/** The reply chip under a thread root in the main list: "↳ 5 replies · @docs" (the last replier, or "you"). */
export const replyLine = (root: Locator): Locator => root.getByRole("button", { name: /^Open thread, / });
/** The faded peek under the chip: "docs: Looks right to me." (the last reply). */
export const replyPeek = (root: Locator): Locator => root.getByRole("button", { name: /^Last reply by / });

/** Open the thread of the message with this text: its reply line when it has replies, else "Reply in thread" in its menu. */
export async function openThread(page: Page, text: string): Promise<void> {
  const root = message(page, text);
  await root.waitFor();
  const line = replyLine(root);
  if (await line.count()) {
    await line.click();
  } else {
    await root.hover();
    await root.getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("menuitem", { name: "Reply in thread" }).click();
  }
  await threadPane(page).waitFor();
}

/** Close the pane: "Close thread" beside the chat, "Back" on a phone. */
export async function closeThread(page: Page): Promise<void> {
  await threadPane(page).getByRole("button", { name: /^(Close thread|Back)$/ }).click();
  await threadPane(page).waitFor({ state: "detached" });
}

/** Write a reply in the open pane and send it with the button (Enter in the field does the same). */
export async function replyInThread(page: Page, text: string): Promise<void> {
  await replyBox(page).fill(text);
  await sendReply(page).click();
}

// ---- the rail -----------------------------------------------------------------------------------------

/** The row of conversation 41 on the Conversations list (open the list first with `openRail`). */
export const rail = (page: Page): Locator => chatRow(page, TITLE);

/** Go to the Conversations list. */
export async function openRail(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/chats`);
  await rail(page).waitFor();
}

/** Is the row bold, and what does its unread pill say ("" for none)? */
export async function railState(page: Page): Promise<{ bold: boolean; unread: string }> {
  const row = rail(page);
  const pill = unreadDot(row.locator("a.chatrow")); // the conversation row; its thread rows count on their own
  return { bold: await isBold(row.getByRole("heading")), unread: (await pill.count()) ? ((await pill.first().textContent()) ?? "").replace(/\s+/g, " ").trim() : "" };
}

/** The "Unread: N" pill of the thread row under conversation 41 in the list, by the root's text. */
export const threadPill = (page: Page, text: string): Locator => page.locator("#chats").getByRole("link", { name: new RegExp(`^Open thread: .*${text}`) }).getByText(/^Unread: \d/);
