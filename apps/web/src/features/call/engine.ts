import type { Message } from "@convoz/api-client";
import type { FunctionResponseScheduling, LiveServerMessage, Session } from "@google/genai";
import { ApiError, call, client } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { data } from "../../shared/data.ts";
import { Player, toBase64 } from "./audio.ts";
import { release, type Gesture } from "./gesture.ts";
import { OwnerIntent } from "./guard.ts";
import { runTool, type ToolDeps } from "./tools.ts";
import workletUrl from "./worklet.js?url&no-inline";

export interface CallOptions {
  conversation: number;
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
  private seen = 0;
  private stop: (() => void)[] = [];
  private readonly hangUpOnLeave = () => this.close();

  constructor(private readonly o: CallOptions) {
    this.player = new Player(o.gesture.ctx);
    addEventListener("pagehide", this.hangUpOnLeave);
  }

  async open(): Promise<void> {
    const { gesture, conversation } = this.o;
    try {
      const stream = await gesture.mic.catch(() => Promise.reject(new Error("Microphone is off. Allow it in Settings, then call again.")));
      if (this.closed) return;
      const token = await call(client.POST("/api/voice/token", { body: { conversation_id: conversation } })).catch((err) => {
        throw new Error(REFUSALS[err instanceof ApiError ? (err.code ?? "") : ""] ?? "The call could not start.");
      });
      if (this.closed) return;
      const { GoogleGenAI, FunctionResponseScheduling } = await import("@google/genai");
      if (this.closed) return;
      const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: "v1alpha" } });
      this.seen = Math.max(0, ...(data.store.getState().messages[conversation]?.list ?? []).map((m) => m.id));
      this.session = await ai.live.connect({
        model: token.model,
        config: token.config as Parameters<typeof ai.live.connect>[0]["config"],
        callbacks: {
          onmessage: (m) => void this.onMessage(m, FunctionResponseScheduling.SILENT),
          onerror: () => this.fail("The call dropped."),
          onclose: () => this.fail("Call ended"),
        },
      });
      if (this.closed) return this.session.close();
      await this.listen(stream);
      this.stop.push(data.store.subscribe(() => this.passOnReplies()));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "The call could not start.");
    }
  }

  mute(on: boolean): void {
    this.muted = on;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    removeEventListener("pagehide", this.hangUpOnLeave);
    for (const f of this.stop) f();
    this.stop = [];
    this.player.interrupt();
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    release(this.o.gesture);
  }

  /** The other end closed the call, or it failed: free everything and tell the owner. */
  private fail(status: string): void {
    if (this.closed) return;
    this.close();
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

  private async onMessage(m: LiveServerMessage, silent: FunctionResponseScheduling): Promise<void> {
    if (this.closed) return;
    if (m.setupComplete) {
      this.ready = true;
      this.o.say("Live");
    }
    const content = m.serverContent;
    if (content?.inputTranscription?.text) this.intent.heard();
    if (content?.interrupted) this.player.interrupt();
    for (const part of content?.modelTurn?.parts ?? []) if (part.inlineData?.data) this.player.play(part.inlineData.data);
    if (m.goAway) this.o.say("The call is about to end.");
    for (const fc of m.toolCall?.functionCalls ?? []) {
      const { response, cue } = await runTool(this.tools(), fc.name ?? "", fc.args);
      if (cue) this.o.say(cue);
      if (!this.closed) this.session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response, scheduling: silent }] });
    }
  }

  /** New messages of the conversation that an agent wrote go to the model as quotes; after one, the owner must speak again to order anything. */
  private passOnReplies(): void {
    const list = data.store.getState().messages[this.o.conversation]?.list ?? [];
    for (const m of list) {
      if (m.id <= this.seen) continue;
      this.seen = m.id;
      const text = replyText(m);
      if (!text || !this.session) continue;
      this.intent.quoted();
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `AGENT REPLY from ${m.author.handle}: ${text}` }] }], turnComplete: true });
      this.o.say(`@${m.author.handle} answered`);
    }
  }

  private tools(): ToolDeps {
    const conversation = this.o.conversation;
    const state = () => data.store.getState();
    return {
      intent: this.intent,
      agents: () => (state().rows[conversation]?.participants ?? []).filter((p) => p.kind === "agent").map((p) => p.handle),
      post: (handle, text) => postAsOwner(conversation, `@${handle} ${text}`),
      recent: (n) => (state().messages[conversation]?.list ?? []).slice(-n).map((m) => ({ author: m.author.handle, text: (m.body ?? "").slice(0, 500) })),
      status: (handle) => ({ handle, online: Boolean(state().identities?.find((p) => p.handle === handle)?.online) }),
    };
  }
}

/** An agent's words, for the model: nothing for the owner's own messages, system lines, deleted ones and files without words. */
function replyText(m: Message): string {
  if (m.author.kind !== "agent" || m.deleted || m.kind === "system") return "";
  return (m.body ?? "").trim().slice(0, MOST_REPLY);
}

/** postAsOwner posts what the owner asked, marked "via voice call", and shows it at once. */
async function postAsOwner(conversation: number, body: string): Promise<void> {
  const sent = await call(client.POST("/api/conversations/{id}/messages", { params: { path: { id: conversation } }, body: { client_id: newId(), body, via_voice: true } }));
  const me = data.store.getState().me!.identity;
  data.putMessages(conversation, [{ id: sent.id, author: { handle: me.handle, display_name: me.display_name, kind: "human" }, body, format: "markdown", created_at: sent.created_at, via_voice: true }]);
}
