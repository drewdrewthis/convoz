import type { Person } from "@convoz/api-client";
import { validateApp, type App, type AppContext, type AppStub, type ProposedResult } from "@convoz/app-kit";
import { lazy, Suspense, useState } from "react";
import { call, client } from "../../shared/api.ts";
import { ConfirmSheet } from "./ConfirmSheet.tsx";
import { useMediaAutoLoads } from "../../shared/media.ts";
import { jsonBytes, saveData, size } from "./env.ts";
import { FrameHost } from "./FrameHost.tsx";
import { sendViaApp, type AppResult, type Target } from "./send.ts";

const AppView = lazy(() => import("@convoz/app-kit/view").then((m) => ({ default: m.AppView })));

export interface AppHostProps {
  /** The app as the message carries it: the app itself, or a stub when it is over 4096 bytes. */
  app: unknown;
  messageId: number;
  agent: Person;
  conversation: number;
  /** The thread the app message is in, if any. */
  threadRoot?: number;
  /** The app sits on an ask: it helps the owner decide and never answers. */
  onAsk?: boolean;
}

const isStub = (a: unknown): a is AppStub => typeof a === "object" && a !== null && (a as { stub?: unknown }).stub === true;
const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;
const FALLBACK = "Update Convoz to view this app";

/** AppHost draws the app of a message or an ask: a collapsed card for a Tier 1 app, a preview card for a Tier 2 app, the fallback text for anything this build cannot show. */
export function AppHost({ app: raw, messageId, agent, conversation, threadRoot, onAsk = false }: AppHostProps) {
  const [full, setFull] = useState<App | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [sheet, setSheet] = useState<ProposedResult | null>(null);
  const [sentError, setSentError] = useState("");
  const auto = useMediaAutoLoads();
  const target: Target = { conversation, message: messageId, agent, threadRoot };
  const root = { "data-app": "", "data-message-id": messageId } as const;

  const stub = isStub(raw) ? raw : null;
  const app = full ?? (stub ? null : (raw as App));
  const type = (app?.type ?? stub?.type ?? "") as string;
  const title = app?.title ?? stub?.title;
  const fallback = app?.fallback ?? stub?.fallback ?? "";

  // What this build cannot show falls back to its text, and says nothing in the console.
  const unsupported = (stub ? stub.v !== 1 : false) || (app ? !validateApp(app).ok || (app.type === "frame" && app.props.manifest.bridge !== 1) : false);
  if (unsupported || failed) return <Fallback root={root} type={type} title={title} text={fallback} />;

  const bytes = stub?.bytes ?? jsonBytes(raw);
  const slowWait = !tapped && !auto && (type === "gallery" || stub !== null) && type !== "frame";

  if (app?.type === "frame") return <FrameHost app={app as App & { type: "frame" }} messageId={messageId} agent={agent} target={target} onAsk={onAsk} />;
  if (stub?.type === "frame") return <FrameStub root={root} stub={stub} agent={agent} load={() => void load()} />;

  async function load() {
    if (full || loading) return;
    setLoading(true);
    try {
      const got = await call(client.GET("/api/messages/{id}/app", { params: { path: { id: messageId } } }));
      setFull(got.app as unknown as App);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  const expand = () => {
    setOpen(true);
    void load();
  };

  if (slowWait) {
    return (
      <section {...root} data-app-type={type} data-app-state="placeholder" aria-label={title ?? "App"} className="appcard">
        <div className="apptitle">
          <strong>{title ?? "App"}</strong>
        </div>
        <div className="appmeta">{`App from @${agent.handle} · ${size(bytes)}`}</div>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setTapped(true);
            expand();
          }}
        >
          {`Tap to load · ${size(bytes)}`}
        </button>
      </section>
    );
  }

  if (!open) {
    return (
      <section {...root} data-app-type={type} data-app-state="collapsed" aria-label={title ?? "App"} className="appcard">
        <div className="apptitle">
          <strong>{title ?? "App"}</strong> <span className="appmeta">{`App from @${agent.handle}`}</span>
        </div>
        <p className="appfallback">{fallback}</p>
        <button type="button" className="btn small quiet" onClick={expand}>
          Expand app
        </button>
      </section>
    );
  }

  const propose = (r: ProposedResult) => {
    if (onAsk) return;
    setSentError("");
    if (r.direct) return void send(r);
    setSheet(r);
  };
  const send = async (r: ProposedResult): Promise<string | null> => {
    const result: AppResult = { v: 1, source: r.source, summary: r.summary, value: r.value };
    try {
      await sendViaApp(target, result);
      return null;
    } catch (err) {
      const text = err instanceof Error ? err.message : "Could not send.";
      setSentError(text);
      return text;
    }
  };
  const ctx: AppContext = { fileUrl, onResult: propose, saveData: saveData(), onAsk };
  return (
    <section {...root} data-app-type={type} data-app-state="expanded" aria-label={title ?? "App"} className="appcard">
      <div className="apptitle">
        <strong>{title ?? "App"}</strong> <span className="appmeta">{`App from @${agent.handle}`}</span>
      </div>
      {app ? (
        <Suspense fallback={<p className="appfallback">{fallback}</p>}>
          <AppView app={app} ctx={ctx} />
        </Suspense>
      ) : (
        <p className="appfallback" role="status">
          Loading…
        </p>
      )}
      {sentError ? <p role="alert">{sentError}</p> : null}
      <button type="button" className="btn small quiet" onClick={() => setOpen(false)}>
        Collapse app
      </button>
      {sheet ? <ConfirmSheet agent={agent.handle} summary={sheet.summary} rows={sheet.rows ?? []} send={() => send(sheet)} onDone={() => setSheet(null)} /> : null}
    </section>
  );
}

function Fallback({ root, type, title, text }: { root: Record<string, unknown>; type: string; title?: string; text: string }) {
  return (
    <section {...root} data-app-type={type || undefined} data-app-state="fallback" aria-label={title ?? "App"} className="appcard">
      <p className="appfallback">{text}</p>
      <p className="appmeta">{FALLBACK}</p>
    </section>
  );
}

/** A Tier 2 app over 4096 bytes arrives as a stub: its card needs the full app (the bundle hash), fetched when the owner taps. */
function FrameStub({ root, stub, agent, load }: { root: Record<string, unknown>; stub: AppStub; agent: Person; load(): void }) {
  return (
    <section {...root} data-app-type="frame" data-app-state="preview" aria-label={stub.title ?? "App"} className="appcard">
      <strong>{stub.title ?? "App"}</strong>
      <div className="appmeta">{`App from @${agent.handle}`}</div>
      <p className="appfallback">{stub.fallback}</p>
      <button type="button" className="btn small" onClick={load}>
        Open app
      </button>
    </section>
  );
}
