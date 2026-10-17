// The Tier 2 frame runtime (docs/messages-apps-spec.md §5.5). `convoz app build` inlines it as the first script of every bundle, so the
// agent's page gets window.convoz and the --cvz-* colour variables without npm. It keeps the FIRST port that a window `convoz.connect`
// message carries and ignores every later window message; everything else travels over that port (schemas/bridge.json).
import { KIT_VERSION } from "../src/kit.ts";

type Status = "sent" | "cancelled" | "rejected" | "not_allowed";
interface Env {
  theme: "light" | "dark";
  tokens: Record<string, string>;
  locale: string;
  reducedMotion: boolean;
  saveData: boolean;
  platform: "phone" | "desktop";
  width: number;
}
interface AppInfo {
  messageId: number;
  title?: string;
  canResult: boolean;
  onAsk: boolean;
}
interface InitPayload {
  app: AppInfo;
  data: unknown;
  env: Env;
}

const MAX_OUT_BYTES = 8192;
const MAX_PER_SECOND = 20;
const TOKENS = ["bg", "raised", "text", "muted", "line", "accent", "onAccent", "good", "warn", "bad"];
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

let port: MessagePort | null = null;
let init: InitPayload | null = null;
const initHandlers: ((p: InitPayload) => void)[] = [];
const dataHandlers: ((p: { data?: unknown; env?: Env }) => void)[] = [];
const waiting = new Map<string, (s: Status) => void>();
let sentThisSecond: number[] = [];

function applyEnv(env: Env) {
  const root = document.documentElement;
  for (const k of TOKENS) if (env.tokens[k]) root.style.setProperty(`--cvz-${kebab(k)}`, env.tokens[k]!);
  root.style.colorScheme = env.theme;
}

function post(msg: Record<string, unknown>): boolean {
  if (!port) return false;
  const text = JSON.stringify(msg);
  const now = Date.now();
  sentThisSecond = sentThisSecond.filter((t) => now - t < 1000);
  if (text.length > MAX_OUT_BYTES || sentThisSecond.length >= MAX_PER_SECOND) return false;
  sentThisSecond.push(now);
  port.postMessage(msg);
  return true;
}

const nonce = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function onPort(e: MessageEvent) {
  const m = e.data as { t?: string; v?: number; [k: string]: unknown } | null;
  if (!m || typeof m !== "object" || m.v !== 1) return;
  if (m.t === "init") {
    init = { app: m.app as AppInfo, data: m.data, env: m.env as Env };
    applyEnv(init.env);
    for (const h of initHandlers) h(init);
  } else if (m.t === "data") {
    if (init) {
      if (m.env) init = { ...init, env: m.env as Env };
      if ("data" in m) init = { ...init, data: m.data };
    }
    if (m.env) applyEnv(m.env as Env);
    for (const h of dataHandlers) h({ data: m.data, env: m.env as Env | undefined });
  } else if (m.t === "ack") {
    const done = waiting.get(String(m.id));
    if (done) {
      waiting.delete(String(m.id));
      done(m.status as Status);
    }
  }
}

function onConnect(e: MessageEvent) {
  const m = e.data as { t?: string; v?: number; versions?: number[] } | null;
  if (port || !m || m.t !== "convoz.connect" || m.v !== 1 || !Array.isArray(m.versions) || !m.versions.includes(1) || !e.ports[0]) return;
  window.removeEventListener("message", onConnect); // the first port is the only one
  port = e.ports[0];
  port.onmessage = onPort;
  post({ t: "ready", v: 1, kit: KIT_VERSION });
}
window.addEventListener("message", onConnect);

const resize = (height: number) => {
  const h = Math.min(20000, Math.max(1, Math.round(height)));
  post({ t: "resize", v: 1, height: h });
};

const convoz = {
  kit: KIT_VERSION,
  onInit(fn: (p: InitPayload) => void) {
    initHandlers.push(fn);
    if (init) fn(init);
  },
  onData(fn: (p: { data?: unknown; env?: Env }) => void) {
    dataHandlers.push(fn);
  },
  resize,
  /** Resize the frame to the height of the document. */
  fit() {
    resize(document.documentElement.scrollHeight);
  },
  /** Propose a result. The host shows its confirm sheet; the promise settles with what the owner did. */
  result(r: { summary: string; value?: unknown }): Promise<Status> {
    const value = r.value === undefined ? null : r.value;
    if (typeof r.summary !== "string" || r.summary.length < 1 || r.summary.length > 280 || JSON.stringify(value).length > 4096) return Promise.resolve("rejected");
    if (init && !init.app.canResult) return Promise.resolve("not_allowed");
    const id = nonce();
    return new Promise<Status>((resolve) => {
      waiting.set(id, resolve);
      if (!post({ t: "result", v: 1, id, summary: r.summary, value })) {
        waiting.delete(id);
        resolve("rejected");
      }
    });
  },
  error(code: "render" | "data" | "unsupported" | "internal", message?: string) {
    post({ t: "error", v: 1, code, ...(message ? { message: message.slice(0, 200).replace(/[\u0000-\u001f]/g, " ") } : {}) });
  },
};
(window as unknown as { convoz: typeof convoz }).convoz = convoz;

// Defaults until the host sends its tokens (light theme of the web app).
const style = document.createElement("style");
style.textContent = ":root{--cvz-bg:#ffffff;--cvz-raised:#ffffff;--cvz-text:#11151c;--cvz-muted:#5b6472;--cvz-line:#d9dde4;--cvz-accent:#3355ff;--cvz-on-accent:#ffffff;--cvz-good:#157f3b;--cvz-warn:#a15c00;--cvz-bad:#c4261d}";
document.documentElement.appendChild(style);
