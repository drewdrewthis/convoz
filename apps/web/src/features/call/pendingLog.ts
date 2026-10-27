import { client } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { callsConversation } from "./now.ts";

const KEY = "convoz.pendingCallLogs";

interface Pending {
  client_id: string;
  body: string;
}

const read = (): Pending[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Pending[];
  } catch {
    return [];
  }
};
const write = (all: Pending[]): void => (all.length ? localStorage.setItem(KEY, JSON.stringify(all)) : localStorage.removeItem(KEY));

/** postLog sends one call log, quiet and by voice. The same client id twice is one message, so a retry never doubles it. */
export async function postLog(conversation: number, p: Pending): Promise<void> {
  await client.POST("/api/conversations/{id}/messages", { params: { path: { id: conversation } }, body: { client_id: p.client_id, body: p.body, format: "plain", via_voice: true, quiet: true }, keepalive: true });
}

/**
 * keepLog writes a log down before its post is tried, for a page that may unload before the Now call's conversation is known.
 * Returns the entry; forget it once the post went through.
 */
export function keepLog(body: string): Pending {
  const p = { client_id: newId(), body };
  write([...read(), p]);
  return p;
}

export function forgetLog(p: Pending): void {
  write(read().filter((x) => x.client_id !== p.client_id));
}

/** sendKeptLogs posts the logs a page left unsent (it unloaded first); the owner's Now page calls it on load. */
export async function sendKeptLogs(): Promise<void> {
  const kept = read();
  if (!kept.length) return;
  try {
    const conversation = await callsConversation();
    for (const p of kept) {
      await postLog(conversation, p);
      forgetLog(p);
    }
  } catch {
    /* kept for the next load */
  }
}
