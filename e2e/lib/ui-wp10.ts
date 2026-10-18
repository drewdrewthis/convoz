import type { BrowserContext, Locator, Page } from "@playwright/test";
import { chatWorld, createConversation, startSession, type AgentSession, type World } from "./chat.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { signInBrowser } from "./machines.ts";
import { addSecondPasskey } from "./mobile.ts";
import type { SoftAuthenticator } from "./soft-authenticator.ts";
import { messageLog } from "./chat-ui.ts";

/**
 * The page contract of WP10 (uploads, voice) that the browser scenarios assert; locators are role and name only, except the file input:
 *   region "Conversation" is the drop target; button "Attach a file" and `input[type=file]`; list "Files to send" with listitems that hold
 *   the file name, a progressbar "Uploading <name>" while it goes, and a button "Remove <name>"; status "10 is the most per message.";
 *   button "Record a voice message"; group "Recording a voice message" with buttons "Cancel recording" and "Send voice message";
 *   a voice message has buttons "Play voice message" / "Pause voice message", a progressbar "Playback progress", its duration as m:ss, an
 *   <audio> element, and a button "Transcript" only when the words exist; an image of a message is an img named by its file name.
 */

export interface VoiceWorld {
  w: World;
  devtool: AgentSession;
  conv: number;
  second: SoftAuthenticator;
}

/** Background: owner "drew" (two passkeys, so a second browser can sign in), "devtool" in conversation 41, the owner's browser signed in on it. */
export async function voiceWorld(fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext }): Promise<VoiceWorld> {
  const w = await chatWorld(fx.server, { agents: ["devtool", "docs"] });
  const devtool = await startSession(w.box, "devtool", "ui-devtool");
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const second = await addSecondPasskey(w.srv, w.owner);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return { w, devtool, conv, second };
}

export async function openConversation(page: Page, srv: ServerHandle, conv: number): Promise<void> {
  await page.goto(`${srv.origin}/chats/${conv}`);
  await page.getByRole("log", { name: "Messages" }).waitFor();
}

export const region = (page: Page): Locator => page.getByRole("region", { name: "Conversation" });
export const filesToSend = (page: Page): Locator => page.getByRole("list", { name: "Files to send" });
export const recordButton = (page: Page): Locator => page.getByRole("button", { name: "Record a voice message" });
export const recording = (page: Page): Locator => page.getByRole("group", { name: "Recording a voice message" });
export const voiceMessages = (page: Page): Locator => messageLog(page).getByRole("article").filter({ has: page.getByRole("button", { name: /^(Play|Pause) voice message$/ }) });

export interface FileSpec {
  name: string;
  type: string;
  bytes: Buffer;
}

/** Drop files on the conversation the way a browser delivers them: dragenter, dragover, drop with a DataTransfer. */
export async function dropFiles(page: Page, files: FileSpec[]): Promise<void> {
  const payload = files.map((f) => ({ name: f.name, type: f.type, bytes: [...f.bytes] }));
  const target = region(page);
  const dt = await page.evaluateHandle((list) => {
    const d = new DataTransfer();
    for (const f of list) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    return d;
  }, payload);
  for (const type of ["dragenter", "dragover", "drop"]) await target.dispatchEvent(type, { dataTransfer: dt });
}

/**
 * Paste files into a box the way a browser delivers them: a bubbling, cancelable `paste` ClipboardEvent whose clipboardData is a
 * DataTransfer that holds the files. Resolves to whether the page took the paste over (preventDefault), which a paste of text must not.
 */
export async function pasteFiles(box: Locator, files: FileSpec[]): Promise<boolean> {
  const payload = files.map((f) => ({ name: f.name, type: f.type, bytes: [...f.bytes] }));
  return box.evaluate((el, list) => {
    const clipboardData = new DataTransfer();
    for (const f of list) clipboardData.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, payload);
}

/** Wait until no file under "Files to send" is still going. */
export async function filesReady(page: Page): Promise<void> {
  await page.getByRole("progressbar", { name: /^Uploading / }).first().waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await Promise.resolve();
}
