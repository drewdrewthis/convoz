/**
 * The call log: what was said (the model's own text transcriptions, never audio) and what happened, with times. The page posts it as one
 * quiet message when the call ends (post.ts), so the owner sees it collapsed in the chat and an agent reads it with `convoz read`.
 */

/** The first words of a call-log message: the chat shows such a message from the owner's voice call collapsed. */
export const CALL_LOG = "Call log";

/** The server holds 16384 bytes of body; the log stays under this. */
const MOST_BYTES = 15_000;
const MOST_EVENT_TEXT = 500;

type Speaker = "owner" | "model" | "model (muted)";

const clock = (t: number): string => new Date(t).toISOString().slice(11, 23);
const bytes = (s: string): number => new TextEncoder().encode(s).length;

export class CallLog {
  private lines: string[] = [];
  private speech: { who: Speaker; text: string; at: number } | null = null;
  private readonly began: number;

  constructor(private readonly now: () => number = Date.now) {
    this.began = now();
  }

  /** A piece of a transcription: pieces of one speaker join into one line until someone else speaks or an event comes. */
  say(who: Speaker, text: string): void {
    if (this.speech?.who !== who) {
      this.flush();
      this.speech = { who, text: "", at: this.now() };
    }
    this.speech!.text += text;
  }

  /** Something happened ("connected", "sent to @dot [message 12]"). */
  event(text: string): void {
    this.flush();
    this.lines.push(`${clock(this.now())} ${text.slice(0, MOST_EVENT_TEXT)}`);
  }

  /** The model finished a turn: its next words are a new line. */
  endTurn(): void {
    this.flush();
  }

  get empty(): boolean {
    return !this.lines.length && !this.speech;
  }

  /** The message body: a first line with the date and length, then one line per event or utterance. */
  render(): string {
    this.flush();
    const seconds = Math.max(0, Math.round((this.now() - this.began) / 1000));
    const head = `${CALL_LOG} (${Math.floor(seconds / 60)}m ${seconds % 60}s, ${new Date(this.began).toISOString().slice(0, 10)} UTC)`;
    let body = this.lines.join("\n");
    let dropped = 0;
    // Too long: the oldest lines go first.
    while (bytes(head + "\n" + body) > MOST_BYTES && this.lines.length - dropped > 1) {
      dropped++;
      body = `[${dropped} earlier lines dropped]\n` + this.lines.slice(dropped).join("\n");
    }
    return `${head}\n${body}`;
  }

  private flush(): void {
    const s = this.speech;
    if (!s) return;
    this.speech = null;
    const text = s.text.trim();
    if (text) this.lines.push(`${clock(s.at)} ${s.who}: ${text.slice(0, 2000)}`);
  }
}

/** A call-log body split into its summary line and its lines; null for any other body. */
export function splitCallLog(body: string): { summary: string; lines: string } | null {
  if (!body.startsWith(CALL_LOG)) return null;
  const at = body.indexOf("\n");
  return at < 0 ? { summary: body, lines: "" } : { summary: body.slice(0, at), lines: body.slice(at + 1) };
}
