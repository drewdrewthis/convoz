import type { Person } from "@convoz/api-client";
import { validateBridge, validateResult, type App, type FrameProps } from "@convoz/app-kit";
import { useEffect, useRef, useState } from "react";
import { ConfirmSheet, rowsOf } from "./ConfirmSheet.tsx";
import { useMediaAutoLoads } from "../../shared/media.ts";
import { frameEnv, size } from "./env.ts";
import { sendViaApp, type Target } from "./send.ts";
import { Button } from "@convoz/ui/Button";

const MAX_IN_BYTES = 8192;
const MAX_PER_SECOND = 20;
const MAX_DROPS = 3;
const MAX_LIVE = 3;
const READY_MS = 5000;
const MAX_RESULTS = 10;

/** The frames that are open, oldest first: a fourth one closes the oldest (§5.6). */
const live: { close(): void }[] = [];

type Phase = "preview" | "open" | "left" | "stalled" | "dropped";

interface Props {
  app: App & { type: "frame" };
  messageId: number;
  agent: Person;
  target: Target;
  onAsk: boolean;
}

/** The host's frame session for one Tier 2 app: preview card first, then a sandboxed iframe that talks over one MessageChannel port. */
export function FrameHost({ app, messageId, agent, target, onAsk }: Props) {
  const props = app.props as FrameProps;
  const m = props.manifest;
  const title = app.title ?? m.name;
  const [phase, setPhase] = useState<Phase>("preview");
  const [height, setHeight] = useState(m.height?.initial ?? app.height ?? 130);
  const [appError, setAppError] = useState("");
  const [sheet, setSheet] = useState<{ summary: string; rows: [string, string][]; resolve(status: "sent" | "cancelled" | "rejected", reason?: string): void; send(): Promise<string | null> } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<{ port: MessagePort | null; loads: number; drops: number; stamps: number[]; results: number; sheetOpen: boolean; ready: boolean; stop(): void }>({
    port: null, loads: 0, drops: 0, stamps: [], results: 0, sheetOpen: false, ready: false, stop() {},
  });
  const slow = !useMediaAutoLoads();

  const close = (to: Phase) => {
    session.current.stop();
    const i = live.findIndex((x) => x === handle.current);
    if (i >= 0) live.splice(i, 1);
    setPhase(to);
  };
  const handle = useRef({ close: () => close("preview") });
  handle.current.close = () => close("preview");

  const open = () => {
    while (live.length >= MAX_LIVE) live[0]!.close();
    live.push(handle.current);
    session.current = { ...session.current, port: null, loads: 0, drops: 0, stamps: [], results: 0, sheetOpen: false, ready: false };
    setAppError("");
    setPhase("open");
  };

  // The frame session lives while the iframe does.
  useEffect(() => {
    if (phase !== "open") return;
    const s = session.current;
    const el = frame.current!;
    let readyTimer = 0;
    const toFrame = (msg: Record<string, unknown>) => s.port?.postMessage({ v: 1, ...msg });
    const ack = (id: string, status: "sent" | "cancelled" | "rejected" | "not_allowed", reason?: string) => toFrame({ t: "ack", id, status, ...(reason ? { reason: reason.slice(0, 140) } : {}) });

    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (e.effectiveDirective === "frame-src" || e.effectiveDirective === "child-src") close("left");
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    const onLoad = () => {
      s.loads++;
      if (s.loads > 1) return close("left"); // a second load: the app navigated itself away (I-46)
      const channel = new MessageChannel();
      s.port = channel.port1;
      channel.port1.onmessage = (ev) => onPort(ev.data);
      el.contentWindow?.postMessage({ t: "convoz.connect", v: 1, versions: [1] }, "*", [channel.port2]);
      readyTimer = window.setTimeout(() => !s.ready && close("stalled"), READY_MS);
    };
    el.addEventListener("load", onLoad);

    const drop = () => {
      if (++s.drops >= MAX_DROPS) close("dropped");
    };

    function onPort(raw: unknown) {
      const now = Date.now();
      s.stamps = s.stamps.filter((t) => now - t < 1000);
      s.stamps.push(now);
      let text = "";
      try {
        text = JSON.stringify(raw);
      } catch {
        return drop();
      }
      if (s.stamps.length > MAX_PER_SECOND || text.length > MAX_IN_BYTES) return drop();
      const verdict = validateBridge("fromFrame", raw);
      if (!verdict.ok) return drop();
      const msg = raw as { t: string; [k: string]: unknown };
      switch (msg.t) {
        case "ready": {
          if (s.ready) return drop();
          s.ready = true;
          clearTimeout(readyTimer);
          toFrame({ t: "init", app: { messageId, title: title.slice(0, 80), canResult: m.results === true, onAsk }, ...(props.data === undefined ? {} : { data: props.data }), env: frameEnv(el.clientWidth || 320) });
          return;
        }
        case "resize": {
          const phone = matchMedia("(max-width: 600px)").matches;
          const cap = Math.min(m.height?.max ?? 600, 600, phone ? Math.round(innerHeight * 0.7) : 600);
          setHeight(Math.max(m.height?.min ?? 80, 80, Math.min(cap, Number(msg.height))));
          return;
        }
        case "error":
          setAppError(String(msg.message ?? "") || "The app reported an error.");
          return;
        case "result":
          return void onResult(String(msg.id), String(msg.summary), msg.value);
      }
    }

    function onResult(id: string, summary: string, value: unknown) {
      if (!m.results) return ack(id, "not_allowed");
      const opt = onAsk && value && typeof value === "object" && "option" in value && Object.keys(value).length === 1;
      if (onAsk) return ack(id, opt ? "sent" : "not_allowed"); // on an ask a result only highlights; it never answers (I-50)
      if (s.sheetOpen || s.results >= MAX_RESULTS) return ack(id, "rejected", "Another result is waiting.");
      const result = { v: 1 as const, source: "frame" as const, summary, value };
      if (JSON.stringify(value ?? null).length > 4096 || !validateResult(app, result).ok) return ack(id, "rejected", "The result is not valid.");
      s.results++;
      s.sheetOpen = true;
      setSheet({
        summary,
        rows: rowsOf(value),
        resolve: (status, reason) => {
          s.sheetOpen = false;
          setSheet(null);
          ack(id, status, reason);
        },
        send: async () => {
          try {
            await sendViaApp(target, result);
            return null;
          } catch (err) {
            return err instanceof Error ? err.message : "Could not send.";
          }
        },
      });
    }

    s.stop = () => {
      clearTimeout(readyTimer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      el.removeEventListener("load", onLoad);
      s.port?.close();
      s.port = null;
      s.sheetOpen = false;
      setSheet(null);
    };
    return () => s.stop();
  }, [phase]);

  useEffect(
    () => () => {
      const i = live.indexOf(handle.current);
      if (i >= 0) live.splice(i, 1);
    },
    [],
  );

  const bytes = size(props.bundle.size);
  const src = `/api/apps/${messageId}/frame?h=${props.bundle.sha256}`;
  const root = { "data-app": "", "data-app-type": "frame", "data-message-id": messageId } as const;

  if (phase === "left" || phase === "stalled" || phase === "dropped") {
    const note = phase === "left" ? "This app tried to leave and was closed" : phase === "stalled" ? "App did not start" : "This app sent too many bad messages and was closed";
    return (
      <section {...root} data-app-state="closed" aria-label={title} className="appcard">
        <p role="status">{note}</p>
        <p>{app.fallback}</p>
        <Button variant="quiet" size="small" onClick={open}>
          Open app again
        </Button>
      </section>
    );
  }
  if (phase === "preview") {
    return (
      <section {...root} data-app-state="preview" aria-label={title} className="appcard">
        <div className="apptitle">
          <strong>{title}</strong> <span className="appmeta">{`v${m.version}`}</span>
        </div>
        <div className="appmeta">{`App from @${agent.handle}`}</div>
        <p className="appfallback">{app.fallback}</p>
        <div className="appmeta">{slow ? `${bytes} · tap to load` : bytes}</div>
        {m.results ? <div className="appmeta">This app can send a reply for you</div> : null}
        <div className="appmeta">Do not type secrets into apps.</div>
        <Button size="small" onClick={open}>
          {slow ? `Open app · ${bytes}` : "Open app"}
        </Button>
      </section>
    );
  }
  return (
    <section {...root} data-app-state="open" aria-label={title} className="appcard">
      <iframe
        ref={frame}
        title={`${title} (sandboxed)`}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        src={src}
        data-message-id={messageId}
        style={{ display: "block", width: "100%", height, border: 0, background: "var(--color-raised)" }}
      />
      {appError ? (
        <div role="status">
          <p className="appmeta">App error</p>
          <p>{app.fallback}</p>
        </div>
      ) : null}
      <Button variant="quiet" size="small" onClick={() => close("preview")}>
        Close app
      </Button>
      {sheet ? <ConfirmSheet agent={agent.handle} summary={sheet.summary} rows={sheet.rows} send={sheet.send} onDone={(sent) => sheet.resolve(sent ? "sent" : "cancelled")} /> : null}
    </section>
  );
}
