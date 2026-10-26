// The send flow, apart from the panel: make the conversation, put the screenshot up, post the first message.
import { conversationTitle, formatMessage } from "./message.ts";
import type { Capture } from "./tab.ts";

/** The calls sendPage makes: Convoz in the panel, a fake in the unit test. */
export interface SendApi {
  createConversation(clientId: string, title: string | undefined, handle: string): Promise<number>;
  uploadPng(conversationId: number, png: Blob): Promise<string>;
  post(conversationId: number, clientId: string, body: string, uploadIds: string[]): Promise<void>;
}

/**
 * Attempt is one send of the form, kept until it succeeds: a retry reuses its client ids (the server makes nothing twice for a
 * client id) and skips the steps that are done.
 */
export interface Attempt {
  conversationClientId: string;
  messageClientId: string;
  conversation?: number;
  /** The screenshot's upload id once it is up; null once it is settled that the message has none. */
  upload?: string | null;
}

export const newAttempt = (): Attempt => ({ conversationClientId: crypto.randomUUID(), messageClientId: crypto.randomUUID() });

export interface SendInput {
  handle: string;
  note: string;
  screenshot: boolean;
  /** Reads the tab (captureTab in the panel). */
  capture(withScreenshot: boolean): Promise<Capture>;
}

/** A send that went: the conversation, and what did not go with it, in plain words. */
export interface Sent {
  conversation: number;
  notes: string[];
}

/**
 * sendPage sends the page to a new conversation with one agent. It records each step that succeeds in `attempt`, so after a
 * failure `attempt.conversation` says whether a conversation exists, and a call with the same attempt picks up from there.
 */
export async function sendPage(api: SendApi, input: SendInput, attempt: Attempt): Promise<Sent> {
  // a screenshot that is already up is not taken again
  const read = await input.capture(input.screenshot && attempt.upload === undefined);
  attempt.conversation ??= await api.createConversation(attempt.conversationClientId, conversationTitle(read.page.title), input.handle);
  if (attempt.upload === undefined) attempt.upload = read.png ? await api.uploadPng(attempt.conversation, read.png) : null;
  await api.post(attempt.conversation, attempt.messageClientId, formatMessage(input.handle, input.note, read.page), attempt.upload ? [attempt.upload] : []);
  const notes: string[] = [];
  if (read.selectionLost) notes.push("This page cannot be captured, so its selected text did not go.");
  if (read.screenshotLost) notes.push("The screenshot could not be taken, so it did not go.");
  return { conversation: attempt.conversation, notes };
}
