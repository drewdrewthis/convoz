import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import { chatWorld, createConversation, listConversations, startSession, type World } from "./chat.ts";
import { expect } from "./fixtures.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { Client } from "./http.ts";
import { signInBrowser } from "./machines.ts";
import { must } from "./owner.ts";
import { messageLog } from "./chat-ui.ts";

/**
 * The page contract of the voice call (specs/features/voice-call.feature); locators are role and name only:
 *   button "Call" in the conversation's top bar, only when voice is on; it opens the region "Call" (not modal: the conversation stays
 *   readable behind it) that holds a status line (role status: "Connecting…", "Live", "Asked @dot", "Call ended"), a button "Mute"
 *   (then "Unmute") and a button "Hang up". A message the call posted shows the words "via voice call".
 * A Now call (issue https://github.com/drewdrewthis/convoz/issues/43) starts from the option "Call" in the group "Quick actions" of the
 * search dialog (Ctrl/Cmd+K, shown only when voice is on). Its pill is the same region "Call", on every signed-in page while the call
 * is on, with the same status, Mute and Hang up, and a timer "Time on the call" ("0:07"). Its log goes to "Calls with @voice".
 * The server's side is /api/voice and /api/voice/token; the test build keeps the token service of Google as a fake (/__test/voice).
 */

export const KEY = "TESTONLY-gemini";
export const OWNER_WORDS = "is the deploy done?";

export interface CallWorld {
  w: World;
  conv: number;
  dot: { sid: string; lease: string };
}

/** Background: owner "drew", agents "dot" (in conversation "Ship search filters") and "ops" (not in it); the owner's browser signed in. */
export async function callWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page?: Page; context?: BrowserContext },
): Promise<CallWorld> {
  const w = await chatWorld(fx.server, { agents: ["dot", "ops"] });
  const dot = await startSession(w.box, "dot", "call-dot");
  const conv = await createConversation(w.owner, { participants: ["dot"], title: "Ship search filters" });
  if (fx.page && fx.context) await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return { w, conv, dot };
}

/** Put the key in the test server (the fake token service answers with it); "" takes it away. */
export async function voiceKey(w: { owner: { client: Client } }, key: string): Promise<void> {
  must(await w.owner.client.request("POST", "/__test/voice", { csrf: true, json: { key } }), "set the voice key");
}

/** What the fake token service of the test server was asked: the key it got and the exact body. */
export async function tokenRequests(w: { owner: { client: Client } }): Promise<{ key: string; body: any }[]> {
  return must(await w.owner.client.get("/__test/voice"), "read the voice requests").json().requests;
}

/** Set the workspace transcription engine ("none" turns voice off too). */
export async function transcription(w: { owner: { client: Client } }, engine: string): Promise<void> {
  must(await w.owner.client.request("PATCH", "/api/settings", { csrf: true, json: { scope: "workspace", key: "transcription.engine", value: engine } }), "set transcription");
}

/** Chromium's fake microphone, for `test.use({ launchOptions })`. */
export const fakeMic = { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] };

/** Remember every track the page's microphone gives, so a scenario can tell whether it is still live. */
export async function trackMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __mic: MediaStreamTrack[] };
    w.__mic = [];
    const md = navigator.mediaDevices;
    if (!md) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const stream = await original(c);
      w.__mic.push(...stream.getTracks());
      return stream;
    };
  });
}

export const micStates = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __mic: MediaStreamTrack[] }).__mic.map((t) => t.readyState));

/** The model on the other end: a fake of Google's live socket that records what the page says and says what a test tells it to. */
export interface FakeModel {
  /** Everything the page sent, in order, parsed. */
  sent: any[];
  closed(): boolean;
  /** The owner's words, as the model's own transcription of the microphone. */
  hear(text: string): void;
  /** The model asks the page to run a tool. */
  call(name: string, args: Record<string, unknown>, id?: string): void;
  /** The model speaks one turn: a piece of voice, its text transcription and the end of the turn. */
  speak(text: string): void;
  /** The tool answers the page sent back. */
  responses(): any[];
  /** The text turns the page sent (what it passes to the model besides audio). */
  turns(): string[];
}

/** 20 ms of silence as the model's voice (24 kHz PCM16). */
const SILENCE = Buffer.alloc(960).toString("base64");

export async function fakeModel(page: Page): Promise<FakeModel> {
  const sent: any[] = [];
  let socket: WebSocketRoute | undefined;
  let closed = false;
  await page.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    socket = ws;
    ws.onMessage((m) => {
      const msg = JSON.parse(m.toString());
      sent.push(msg);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
    });
    ws.onClose(() => {
      closed = true;
    });
  });
  const say = (m: unknown) => {
    if (!socket) throw new Error("the page has not opened the socket to the model");
    socket.send(JSON.stringify(m));
  };
  let n = 0;
  return {
    sent,
    closed: () => closed,
    hear: (text) => say({ serverContent: { inputTranscription: { text } } }),
    speak: (text) => say({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: SILENCE } }] }, outputTranscription: { text }, turnComplete: true } }),
    call: (name, args, id = `call-${++n}`) => say({ toolCall: { functionCalls: [{ id, name, args }] } }),
    responses: () => sent.filter((m) => m.toolResponse).flatMap((m) => m.toolResponse.functionResponses),
    turns: () => sent.filter((m) => m.clientContent).flatMap((m) => m.clientContent.turns.flatMap((t: any) => t.parts.map((p: any) => p.text))),
  };
}

export const callButton = (page: Page): Locator => page.getByRole("button", { name: "Call", exact: true });
export const callSheet = (page: Page): Locator => page.getByRole("region", { name: "Call" });
export const callStatus = (page: Page): Locator => callSheet(page).getByRole("status");

export async function openConversation(page: Page, srv: ServerHandle, conv: number): Promise<void> {
  await page.goto(`${srv.origin}/chats/${conv}`);
  await expect(messageLog(page)).toBeVisible();
}

/** Given the owner is on a call: the conversation is open, Call tapped, the model's socket answered. */
export async function onACall(page: Page, srv: ServerHandle, conv: number): Promise<FakeModel> {
  const model = await fakeModel(page);
  await trackMicrophone(page);
  await openConversation(page, srv, conv);
  await callButton(page).click();
  await expect(callStatus(page)).toHaveText("Live");
  return model;
}

/** The posts of the owner in a conversation, as the server holds them. */
export async function ownerPosts(w: World, conv: number): Promise<{ body: string; via_voice?: boolean }[]> {
  const res = must(await w.owner.client.get(`/api/conversations/${conv}/messages`), "read the conversation");
  return (res.json().messages as { author: { handle: string }; body: string; via_voice?: boolean }[]).filter((m) => m.author.handle === "drew");
}

/** The call logs in a conversation as the server holds them: the owner's messages marked "via voice call" that start with "Call log". */
export async function callLogs(w: World, conv: number): Promise<{ body: string; via_voice?: boolean }[]> {
  return (await ownerPosts(w, conv)).filter((m) => m.via_voice && m.body.startsWith("Call log"));
}

/** The conversation that holds the logs of Now calls. */
export const CALLS_TITLE = "Calls with @voice";

/** The pill of a Now call: the same region "Call" as the sheet, drawn over every page. */
export const callPill = callSheet;

export const searchDialog = (page: Page): Locator => page.getByRole("dialog", { name: "Search" });

/** The first visible link of that name: the sidebar on a wide screen, the tab bar on a phone. */
export const visibleLink = (page: Page, name: string | RegExp): Locator => page.getByRole("link", { name }).filter({ visible: true }).first();

/** Open search with the keys and pick the quick action "Call". */
export async function startNowCallFromSearch(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+K");
  await searchDialog(page).getByRole("group", { name: "Quick actions" }).getByRole("option", { name: /^Call\b/ }).click();
}

/** Given the owner is on a Now call: Now is open, Call picked in search, the model's socket answered. */
export async function onANowCall(page: Page, srv: ServerHandle): Promise<FakeModel> {
  const model = await fakeModel(page);
  await trackMicrophone(page);
  await page.goto(`${srv.origin}/`);
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();
  await startNowCallFromSearch(page);
  await expect(callStatus(page)).toHaveText("Live");
  return model;
}

/** The conversations titled "Calls with @voice" and the call logs in them, as the server holds them. */
export async function nowCallLogs(w: World): Promise<{ conversations: number[]; logs: { body: string; via_voice?: boolean }[] }> {
  const conversations = (await listConversations(w.owner)).filter((c) => c.title === CALLS_TITLE).map((c) => c.id);
  const logs = [];
  for (const id of conversations) logs.push(...(await callLogs(w, id)));
  return { conversations, logs };
}
