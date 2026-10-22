// The triage call's writes. None runs when the model asks: each is planned, read back to the owner and held; confirm_action runs it only
// when the owner has spoken since the read-back (Held, tools.ts). A model that reads agents' words can be talked into asking for a write
// and for its confirm; it cannot make the owner speak, so a held write waits for his own voice.
import { answerAsk, snoozeAsk } from "../now/index.ts";
import { setStar } from "../rail/index.ts";
import { ApiError, call, client, humanError } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { pick } from "./reads.ts";

/** One write the owner has heard and not yet said yes to. `run` does it and says what it did. */
export interface Planned {
  readBack: string;
  run(): Promise<string>;
}

/**
 * Held is the one write that waits for the owner's yes. A new plan or a cancel drops it; confirm takes it, so a second yes does nothing.
 * A plan made after a newer drop is not held: the owner's later word wins over a slow read. It notes how often the owner had spoken
 * (OwnerIntent.spoken) when it was held: a confirm with no word from him since is not his yes.
 */
export class Held {
  private planned: Planned | null = null;
  private turn = 0;
  private spokenAt = 0;

  get waiting(): boolean {
    return this.planned !== null;
  }

  /** Drops the held write and returns the turn a plan started now must hold in. */
  drop(): number {
    this.planned = null;
    return ++this.turn;
  }

  hold(turn: number, p: Planned, spoken: number): boolean {
    if (turn !== this.turn) return false;
    this.planned = p;
    this.spokenAt = spoken;
    return true;
  }

  /** Whether the owner has spoken since the write was held; `spoken` is OwnerIntent.spoken now. */
  heardSince(spoken: number): boolean {
    return spoken > this.spokenAt;
  }

  take(): Planned | null {
    const p = this.planned;
    this.drop();
    return p;
  }
}

/** A failure already in words the call can say. */
class Spoken extends Error {}

/** spoken turns a failed plan or write into one short sentence for the model to say; it never throws. */
export function spoken(err: unknown): string {
  if (err instanceof Spoken) return err.message;
  if (err instanceof ApiError) {
    if (err.code === "owner_spoke_last") return "You wrote the last message there, so it cannot go stale.";
    if (err.code === "preset_unavailable") return "It is too late for tonight; try tomorrow.";
    if (err.status === 404 || err.status === 403) return "I cannot find that.";
    if (err.status === 409) return "That changed meanwhile, so nothing was done.";
  }
  return humanError(err) || "That did not work.";
}

export type Until = "1h" | "tonight" | "tomorrow";
const UNTIL: Record<Until, string> = { "1h": "for an hour", tonight: "until tonight", tomorrow: "until tomorrow" };
const MOST_QUOTE = 120;
/** Someone else's words the read-back names (an ask, the message replied to): cut, since the write does not send them. */
const quote = (text: string): string => `"${text.length > MOST_QUOTE ? text.slice(0, MOST_QUOTE - 1) + "…" : text}"`;
/** The most characters the call writes in the owner's name: he hears every one of them read back before his yes. */
export const MOST_SAID = 300;
/** The words the write sends, whole; longer than MOST_SAID they are refused, never cut: what is read back is what is sent. */
const said = (text: string): string => {
  if (text.length > MOST_SAID) throw new Spoken("That is too long to read back. Say it in fewer words.");
  return `"${text}"`;
};

async function conversation(id: number | undefined, title: string): Promise<{ id: number; title: string }> {
  // No id and no title would match every title: a write never guesses its conversation.
  const found = id || title ? await pick(id, title) : null;
  if (!found) throw new Spoken("I cannot find that conversation.");
  return { id: found.id, title: found.title || "the conversation with no title" };
}

/** @voice, the server's built-in agent the call writes as (identity.VoiceHandle): words a model wrote never pass as the owner's own. */
export const VOICE = { handle: "voice", display_name: "Voice", kind: "agent" as const };

/** postAsVoice posts for the owner with @voice as the author (as_voice, the owner only); a root makes it a reply in that thread. */
export async function postAsVoice(conv: number, body: string, root?: number) {
  return call(client.POST("/api/conversations/{id}/messages", { params: { path: { id: conv } }, body: { client_id: newId(), body, as_voice: true, ...(root ? { thread_root_id: root } : {}) } }));
}

async function openAsk(id: number) {
  const { ask } = await call(client.GET("/api/asks/{id}", { params: { path: { id } } }));
  if (ask.state !== "open") throw new Spoken("That ask is no longer open.");
  return { ask, where: (await conversation(ask.conversation_id, "")).title, what: `@${ask.asker.handle}'s ask ${quote(ask.question)}` };
}

/** The writes a triage call can plan; each reads what it names first, so the read-back says the title and the words. */
export const plans = {
  async post(id: number | undefined, title: string, text: string): Promise<Planned> {
    const c = await conversation(id, title);
    return { readBack: `I will post ${said(text)} in ${c.title}. Say yes to send.`, run: () => postAsVoice(c.id, text).then(() => `Posted in ${c.title}.`) };
  },

  async reply(root: number, text: string): Promise<Planned> {
    const thread = await call(client.GET("/api/messages/{id}/replies", { params: { path: { id: root }, query: { limit: 1 } } }));
    const c = await conversation(thread.conversation_id, "");
    const of = `@${thread.root.author.handle}'s message ${quote(thread.root.body ?? "")}`;
    return { readBack: `I will reply ${said(text)} to ${of} in ${c.title}. Say yes to send.`, run: () => postAsVoice(c.id, text, root).then(() => `Replied in ${c.title}.`) };
  },

  /** option 1 is the recommended one, 2 and on the alternatives; words instead answer in the owner's own words. */
  async answer(id: number, option: number, words: string): Promise<Planned> {
    const { ask, where, what } = await openAsk(id);
    const label = words || ask.options[option - 1]?.label;
    if (!label) throw new Spoken(`That ask has ${ask.options.length} options.`);
    const choice = words ? { choice: "custom" as const, text: words } : option === 1 ? { choice: "recommended" as const } : { choice: "alternative" as const, index: option - 1 };
    return {
      readBack: `I will answer ${what} in ${where} with ${words ? said(words) : quote(label)}. Say yes to send.`,
      run: async () => {
        const r = await answerAsk(id, { ...choice, if_version: ask.version, via: "now" });
        if (r.lost) throw new Spoken("That ask changed meanwhile, so it was not answered. Read it again.");
        return `Answered in ${where}.`;
      },
    };
  },

  async snooze(id: number, until: Until): Promise<Planned> {
    const { where, what } = await openAsk(id);
    return { readBack: `I will snooze ${what} in ${where} ${UNTIL[until]}. Say yes to snooze.`, run: () => snoozeAsk(id, until).then(() => `Snoozed ${UNTIL[until]}.`) };
  },

  async stale(id: number | undefined, title: string): Promise<Planned> {
    const c = await conversation(id, title);
    return {
      readBack: `I will mark ${c.title} stale. Say yes to mark it.`,
      run: () => call(client.POST("/api/conversations/{id}/stale", { params: { path: { id: c.id } }, body: {} })).then(() => `${c.title} is stale.`),
    };
  },

  async star(id: number | undefined, title: string, on: boolean): Promise<Planned> {
    const c = await conversation(id, title);
    const verb = on ? "star" : "unstar";
    return { readBack: `I will ${verb} ${c.title}. Say yes to ${verb} it.`, run: () => setStar(c.id, on).then(() => `${on ? "Starred" : "Unstarred"} ${c.title}.`) };
  },
};

export type Plans = typeof plans;
