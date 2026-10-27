import type { Message } from "@convoz/api-client";
import type { FunctionResponseScheduling, LiveServerMessage, Session } from "@google/genai";
import { ApiError, call, client } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";
import { Player, toBase64 } from "./audio.ts";
import { release, type Gesture } from "./gesture.ts";
import { OwnerIntent } from "./guard.ts";
import { CallLog } from "./log.ts";
import { forgetLog, keepLog, postLog } from "./pendingLog.ts";
import { callsConversation, readNow } from "./now.ts";
import { listConversations, readConversation, searchMessages } from "./reads.ts";
import { runTool, type ToolDeps } from "./tools.ts";
import { Held, plans, postAsVoice, VOICE } from "./writes.ts";
import type { CallTarget } from "./store.ts";
import { Waiting } from "./waiting.ts";
import workletUrl from "./worklet.js?url&no-inline";

export interface CallOptions {
  /** A conversation, or Now (the triage call: it reads, writes only what the owner said yes to, and leaves its log in now.ts CALLS_TITLE). */
  target: CallTarget;
  gesture: Gesture;
  /** The status line. */
  say(status: string): void;
  /** The call is over without the owner hanging up (the other end closed it, or it could not start). */
  over(status: string): void;
}

export interface CallControl {
  close(): void;
  mute(on: boolean): void;
}

/** The longest an agent's reply may be when it is passed to the model. */
const MOST_REPLY = 4000;

/** How long a question may wait for its agent before the call says so (once). */
const NO_ANSWER_MS = 120_000;

/** The thread of a message the call posted: how many replies the page has seen of it, and how far it passed them on. */
interface AskedThread {
  handle: string;
  replies: number;
  lastReply: number;
  fetching: boolean;
}

const REFUSALS: Record<string, string> = { voice_off: "Calls are off.", rate_limited: "Too many calls this hour. Wait a little." };

/** runCall starts a call and returns at once; the returned control can hang it up even while it is still connecting. */
export function runCall(opts: CallOptions): CallControl {
  const c = new Call(opts);
  void c.open();
  return c;
}

/**
 * One call. The microphone goes to the model as 16 kHz PCM16 (worklet.js), its voice comes back as 24 kHz PCM16, and its tool calls
 * run here with the owner's own session. New agent messages in the conversation go to the model as quotes ("AGENT REPLY from <handle>:").
 * What may make the call post is decided here in code (guard.ts, tools.ts), not by the instructions alone.
 */
class Call implements CallControl {
  private closed = false;
  private muted = false;
  private ready = false;
  private session: Session | undefined;
  private player: Player;
  private intent = new OwnerIntent();
  /** The triage call's one write that waits for the owner's yes; it lives as long as the call. */
  private held = new Held();
  private seen = 0;
  private readonly delivered = new Set<number>();
  /** The messages this call posted, by id: the answer may come in the main chat or in their threads. */
  private readonly asked = new Map<number, AskedThread>();
  /** The agents the call still waits for, with the timer of the "no answer yet" line. */
  private readonly awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiting = new Waiting();
  private readonly log = new CallLog();
  private stop: (() => void)[] = [];
  /**
   * Where the log goes, known before the hang-up: then the log's post leaves at once with keepalive and survives a reload or a closed
   * tab. A conversation call's own conversation; a Now call's is looked up (or made) as soon as the microphone is granted.
   */
  private logHome: number | Promise<number> | null;
  private readonly hangUpOnLeave = () => this.close();

  constructor(private readonly o: CallOptions) {
    this.logHome = o.target === "now" ? null : o.target;
    this.player = new Player(o.gesture.ctx);
    addEventListener("pagehide", this.hangUpOnLeave);
  }

  /** The conversation of a call in one; null for a Now call. */
  private get conversation(): number | null {
    return this.o.target === "now" ? null : this.o.target;
  }

  async open(): Promise<void> {
    const { gesture } = this.o;
    const conversation = this.conversation;
    try {
      const stream = await gesture.mic.catch(() => Promise.reject(new Error("Microphone is off. Allow it in Settings, then call again.")));
      if (this.closed) return;
      // Beside the token, not after it: the id must be in hand long before a reload, whose pagehide cannot wait for two requests.
      if (this.logHome === null) void this.findLogHome();
      const body = conversation === null ? { scope: "now" as const } : { conversation_id: conversation };
      const token = await call(client.POST("/api/voice/token", { body })).catch((err) => {
        throw new Error(REFUSALS[err instanceof ApiError ? (err.code ?? "") : ""] ?? "The call could not start.");
      });
      if (this.closed) return;
      const { GoogleGenAI, FunctionResponseScheduling } = await import("@google/genai");
      if (this.closed) return;
      const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: "v1alpha" } });
      if (conversation !== null) this.seen = Math.max(0, ...(data.store.getState().messages[conversation]?.list ?? []).map((m) => m.id));
      else void data.loadIdentities().catch(() => {}); // agent_status names any agent
      this.session = await ai.live.connect({
        model: token.model,
        config: token.config as Parameters<typeof ai.live.connect>[0]["config"],
        callbacks: {
          onmessage: (m) => void this.onMessage(m, FunctionResponseScheduling),
          onerror: () => this.fail("The call dropped.", true),
          onclose: () => this.fail("Call ended"),
        },
      });
      if (this.closed) return this.session.close();
      await this.listen(stream);
      if (conversation !== null) this.stop.push(data.store.subscribe(() => this.passOnReplies()));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "The call could not start.", true);
    }
  }

  mute(on: boolean): void {
    this.muted = on;
  }

  close(reason = "hung up by the owner"): void {
    if (this.closed) return;
    this.closed = true;
    removeEventListener("pagehide", this.hangUpOnLeave);
    for (const f of this.stop) f();
    this.stop = [];
    for (const t of this.awaiting.values()) clearTimeout(t);
    this.awaiting.clear();
    this.log.event(`ended: ${reason}`);
    void saveCallLog(this.logHome ?? this.findLogHome(), this.log);
    this.player.interrupt();
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    release(this.o.gesture);
  }

  /** A Now call's log home, once: the id replaces the promise when it comes, so the hang-up need not wait on it. */
  private findLogHome(): Promise<number> {
    const home = callsConversation();
    this.logHome = home;
    home.then(
      (id) => {
        this.logHome = id;
      },
      () => {
        if (this.logHome === home) this.logHome = null; // the hang-up tries again
      },
    );
    return home;
  }

  /** The other end closed the call, or it failed: free everything and tell the owner. */
  private fail(status: string, error = false): void {
    if (this.closed) return;
    if (error) this.log.event(`error: ${status}`);
    this.close(status);
    this.o.over(status);
  }

  /** The microphone into the worklet, the worklet's pieces to the model. */
  private async listen(stream: MediaStream): Promise<void> {
    const { ctx } = this.o.gesture;
    await ctx.audioWorklet.addModule(workletUrl);
    if (this.closed) return;
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm16-downsampler");
    const silent = ctx.createGain(); // a worklet is only pulled while it leads to the destination; this leads there without a sound
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ready && !this.muted && !this.closed) this.session?.sendRealtimeInput({ audio: { data: toBase64(e.data), mimeType: "audio/pcm;rate=16000" } });
    };
    this.stop.push(() => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
    });
  }

  private async onMessage(m: LiveServerMessage, scheduling: typeof FunctionResponseScheduling): Promise<void> {
    if (this.closed) return;
    if (m.setupComplete) {
      this.ready = true;
      this.log.event("connected");
      this.o.say("Live");
    }
    const content = m.serverContent;
    if (content?.inputTranscription?.text) {
      this.intent.heard();
      this.waiting.end();
      this.log.say("owner", content.inputTranscription.text);
    }
    if (content?.interrupted) this.player.interrupt();
    for (const part of content?.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      if (this.waiting.allowsAudio()) this.player.play(part.inlineData.data);
    }
    if (content?.outputTranscription?.text) this.log.say(this.waiting.muting ? "model (muted)" : "model", content.outputTranscription.text);
    if (content?.turnComplete) {
      this.waiting.turnDone();
      this.log.endTurn();
    }
    if (m.goAway) this.o.say("The call is about to end.");
    for (const fc of m.toolCall?.functionCalls ?? []) {
      const began = Date.now();
      const { response, cue } = await runTool(this.tools(), fc.name ?? "", fc.args);
      this.log.event(`tool ${fc.name} took ${Date.now() - began}ms`);
      if (cue) this.o.say(cue);
      // SILENT adds the answer to the model's context and triggers nothing, so the model stayed mute for a minute after every read or
      // write until the owner spoke again (call of 2026-10-22). Only the question to an agent keeps the quiet: waiting.ts and its answer say so.
      const when = fc.name === "ask_agent" ? scheduling.SILENT : scheduling.WHEN_IDLE;
      if (!this.closed) this.session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response, scheduling: when }] });
    }
  }

  /**
   * An agent's words go to the model as quotes, once each, in order: new messages of the main chat, and the replies in the threads of the
   * messages this call posted (an agent may answer a question in its thread, as it did for the owner's call on 2026-10-20). After one,
   * the owner must speak again to order anything.
   */
  private passOnReplies(): void {
    const state = data.store.getState();
    for (const m of state.messages[this.conversation ?? -1]?.list ?? []) {
      if (m.id > this.seen) {
        this.seen = m.id;
        this.deliver(m);
      }
      const thread = this.asked.get(m.id);
      if (thread && (m.reply_count ?? 0) > thread.replies) void this.readThread(m.id, thread);
    }
  }

  /** Read the replies of a thread past the last one passed on, then look again if more came meanwhile. */
  private async readThread(root: number, thread: AskedThread): Promise<void> {
    if (thread.fetching) return;
    thread.fetching = true;
    try {
      const count = data.store.getState().messages[this.conversation ?? -1]?.list.find((m) => m.id === root)?.reply_count ?? 0;
      const { messages } = await call(client.GET("/api/messages/{id}/replies", { params: { path: { id: root }, query: { after: thread.lastReply, limit: 100 } } }));
      thread.replies = Math.max(thread.replies, count);
      for (const m of messages) {
        thread.lastReply = Math.max(thread.lastReply, m.id);
        if (!this.closed) this.deliver(m);
      }
      thread.fetching = false;
      if (!this.closed) this.passOnReplies(); // more may have come while this read ran
    } catch {
      thread.fetching = false; // the next change of the thread reads it again
    }
  }

  private deliver(m: Message): void {
    const text = replyText(m);
    if (!text || !this.session || this.delivered.has(m.id)) return;
    this.delivered.add(m.id);
    this.intent.quoted();
    this.waiting.end();
    clearTimeout(this.awaiting.get(m.author.handle));
    this.awaiting.delete(m.author.handle);
    this.log.event(`@${m.author.handle} answered [message ${m.id}]: ${text}`);
    this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `AGENT REPLY from ${m.author.handle}: ${text}` }] }], turnComplete: true });
    this.log.event(`read out @${m.author.handle} [message ${m.id}]`);
    this.o.say(`@${m.author.handle} answered`);
  }

  /** The call posted a question: it listens to that message's thread, tells the model to wait quietly, and says so once if no answer comes. */
  private asking(handle: string, id: number): void {
    this.log.event(`sent to @${handle} [message ${id}]`);
    this.asked.set(id, { handle, replies: 0, lastReply: 0, fetching: false });
    this.waiting.begin();
    clearTimeout(this.awaiting.get(handle));
    this.awaiting.set(
      handle,
      setTimeout(() => this.noAnswer(handle), NO_ANSWER_MS),
    );
  }

  /** Our own notice, not an agent's words: it asks the model for the one line and leaves the owner's right to order as it is. */
  private noAnswer(handle: string): void {
    this.awaiting.delete(handle);
    if (this.closed || !this.session) return;
    this.log.event(`waiting timeout: no answer from @${handle}`);
    this.waiting.allowOneLine();
    this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `NOTICE from the call: @${handle} has not answered yet. Say once "No answer yet from @${handle}", then stay quiet and keep listening.` }] }], turnComplete: true });
    this.o.say(`No answer yet from @${handle}`);
  }

  private tools(): ToolDeps {
    const conversation = this.conversation;
    const state = () => data.store.getState();
    const status = (handle: string) => ({ handle, online: Boolean(state().identities?.find((p) => p.handle === handle)?.online) });
    if (conversation === null) {
      return {
        intent: this.intent,
        agents: () => (state().identities ?? []).filter((p) => p.kind === "agent").map((p) => p.handle),
        status,
        now: readNow,
        search: searchMessages,
        conversations: listConversations,
        conversation: readConversation,
        plans,
        held: this.held,
      };
    }
    return {
      intent: this.intent,
      agents: () => (state().rows[conversation]?.participants ?? []).filter((p) => p.kind === "agent").map((p) => p.handle),
      post: async (handle, text) => this.asking(handle, await postAsk(conversation, `@${handle} ${text}`)),
      recent: (n) => (state().messages[conversation]?.list ?? []).slice(-n).map((m) => ({ author: m.author.handle, text: (m.body ?? "").slice(0, 500) })),
      status,
    };
  }
}

/** An agent's words, for the model: nothing for the owner's own messages, @voice's (the call's own), system lines, deleted ones and files without words. */
function replyText(m: Message): string {
  if (m.author.kind !== "agent" || m.author.handle === VOICE.handle || m.deleted || m.kind === "system") return "";
  return (m.body ?? "").trim().slice(0, MOST_REPLY);
}

/** postAsk posts what the owner asked as @voice, and shows it at once. */
async function postAsk(conversation: number, body: string): Promise<number> {
  const sent = await postAsVoice(conversation, body);
  data.putMessages(conversation, [{ id: sent.id, author: VOICE, body, format: "markdown", created_at: sent.created_at }]);
  return sent.id;
}

/**
 * The log of a finished call goes to its conversation (a Now call's to CALLS_TITLE, now.ts) as one quiet message: no agent is woken,
 * and the main list shows it collapsed. With the conversation's id at hand the post leaves before anything else is awaited, so a page that is
 * going away still sends it (keepalive).
 */
async function saveCallLog(home: number | Promise<number>, log: CallLog): Promise<void> {
  if (log.empty) return;
  // Written down first: a page that unloads before the conversation is known leaves the log for the next load (pendingLog.ts).
  const kept = keepLog(log.render());
  try {
    if (await postLog(typeof home === "number" ? home : await home, kept)) forgetLog(kept);
  } catch {
    /* the call is over; a log that cannot be saved is sent on the next load, not shown as an error */
  }
}
