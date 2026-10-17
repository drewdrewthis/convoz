import type { Identity, Message } from "@convoz/api-client";
import { BackIcon, DetailsIcon } from "@convoz/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { ApiError } from "../../shared/api.ts";
import { initials, paletteOf, setRegistry, stripCf } from "../../shared/chat.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { Composer } from "../composer/index.ts";
import { rememberChat } from "../search/index.ts";
import { ThreadPane, useThreads } from "../threads/index.ts";
import { resume } from "./actions.ts";
import { Details } from "./Details.tsx";
import { MessageDetails } from "./MessageDetails.tsx";
import { useConversations, type PendingSend } from "./store.ts";
import { ThreadBubbles, Transcript, type TranscriptControl } from "./Transcript.tsx";

const NEW = "new";
const GONE = "This chat does not exist, or it is not yours.";
const NONE: Message[] = [];
const NO_SENDS: PendingSend[] = [];

/**
 * Conversation is /chats/:id and /chats/new: a full-screen chat with Back and the agent in the top bar, the log, and the
 * composer pinned to the bottom of the visible screen. New conversation starts blank; "@" brings in an agent, and the first
 * send makes the conversation and moves the URL to it.
 */
export function Conversation() {
  const [isNew] = useState(() => location.pathname === "/chats/new");
  const [key] = useState(() => (isNew ? NEW : location.pathname.split("/")[2]!));
  const thread = useConversations((s) => s.threads[key]);
  const convId = thread?.convId ?? 0;
  const conversation = useData((s) => (convId ? s.rows[convId] : undefined));
  const held = useData((s) => (convId ? s.messages[convId] : undefined));
  const me = useData((s) => s.me?.identity.handle ?? "");
  const people = useData((s) => s.identities);
  const actions = useConversations.getState;
  const [agentHandle, setAgentHandle] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const [info, setInfo] = useState(false);
  const [inspected, setInspected] = useState<Message | null>(null);
  const threadOpen = useThreads((s) => s.open !== null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const control = useRef<TranscriptControl>(null);
  // A search result opens the conversation at its message: /chats/<id>#m<message id>.
  const [target] = useState(() => Number(/^#m(\d+)$/.exec(location.hash)?.[1] ?? 0));

  const crew = useMemo(() => (people ?? []).filter((p) => p.kind === "agent" && !p.disabled), [people]);
  const agents = (conversation?.participants ?? []).filter((p) => p.kind === "agent");
  const agent = agentHandle ? { handle: agentHandle, online: Boolean(people?.find((p) => p.handle === agentHandle)?.online) } : null;
  const working = agent && thread?.working?.handle === agent.handle ? thread.working : null;
  // An existing chat is "Chat" until its row is in; an untitled one is "New conversation".
  const title = gone ? "Chat not found" : !isNew && !conversation ? "Chat" : stripCf(conversation?.title ?? "") || "New conversation";

  useEffect(() => {
    document.title = `${title} - Convoz`;
  }, [title]);

  const fit = useFitFrame(frame);

  // The details and a thread share the right edge: opening one closes the other. A thread belongs to this page.
  useEffect(() => {
    if (threadOpen) setInfo(false);
  }, [threadOpen]);
  useEffect(() => {
    if (info) useThreads.getState().close();
  }, [info]);
  useEffect(() => () => useThreads.getState().close(), []);

  // "I" shows or hides the details, unless the person is typing.
  useEffect(() => {
    if (!convId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() !== "i" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog")) return;
      setInfo((on) => !on);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [convId]);

  const openWith = useCallback(
    (handle: string) => {
      setAgentHandle(handle);
      fit();
      textRef.current?.focus();
    },
    [fit],
  );

  // Open: who I am and the crew, then the conversation (or the blank new one).
  useEffect(() => {
    (async () => {
      const s = actions();
      const [, everyone] = await Promise.all([data.loadMe(), data.loadIdentities()]);
      setRegistry(everyone);
      if (isNew) {
        textRef.current?.focus(); // the gradient ring shows at once, as in the prototype
        const wanted = everyone.find((p) => p.kind === "agent" && !p.disabled && p.handle === new URLSearchParams(location.search).get("with"));
        if (wanted) {
          s.startThread(NEW, wanted.handle);
          openWith(wanted.handle);
        }
        return;
      }
      const id = Number(key);
      try {
        await s.openThread(key, id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setGone(true);
          setError(GONE);
          return;
        }
        throw err;
      }
      if (target) await loadUntil(s, key, id, target);
      rememberChat(id);
      const who = data.store.getState().rows[id]!.participants.find((p) => p.kind === "agent") ?? { handle: "agent" };
      setAgentHandle(who.handle);
      fit();
      setOpened(true);
      void s.markRead(key);
    })().catch((err) => {
      if (err instanceof ApiError && err.handled) return;
      setError((err && err.message) || "Something went wrong. Try again.");
    });
  }, [isNew, key, openWith, fit, actions, target]);

  // The first send made the conversation: the URL names it now.
  useEffect(() => {
    if (isNew && convId) history.replaceState(null, "", `/chats/${convId}`);
  }, [isNew, convId]);

  useLive(() => {
    const s = actions();
    void s.catchUp(key);
    void s.markRead(key);
    data.loadIdentities().catch(() => {});
  });

  // Leaving right after opening must not lose the cursor: a keepalive request outlives the page.
  useEffect(() => {
    const leave = () => actions().flushRead(key);
    addEventListener("pagehide", leave);
    return () => removeEventListener("pagehide", leave);
  }, [key, actions]);

  // The working note: shown until a message from the agent, a stop frame, or its `until`.
  useEffect(() => {
    if (!working) return;
    control.current?.followIfStuck();
    const timer = setTimeout(() => actions().clearWorking(key), Math.max(0, working.until - Date.now()));
    return () => clearTimeout(timer);
  }, [working, key, actions]);

  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    const sameSite = document.referrer.startsWith(location.origin + "/");
    if (history.length > 1 && sameSite) {
      event.preventDefault();
      history.back();
    }
  };

  const send = (body: string) => {
    control.current?.stick();
    actions().send(key, body);
  };

  const pick = (who: Identity) => {
    history.replaceState(null, "", `/chats/new?with=${encodeURIComponent(who.handle)}`);
    actions().startThread(NEW, who.handle);
    openWith(who.handle);
  };

  const presence = !agent ? null : working ? ["Working…", "busy"] : agent.online ? ["Online", "on"] : ["Offline", ""];
  const chips = agentHandle && !conversation ? [agentHandle] : agents.map((p) => p.handle);
  const label = !agent ? "Message" : agents.length > 1 ? "Message" : `Message @${agent.handle}`;

  return (
    <div className="chatframe" id="frame" ref={frame}>
      <header className="appbar chatbar">
        <a id="back" className="iconbtn" href="/chats" aria-label="Back" onClick={back}>
          <BackIcon />
        </a>
        <div className="titles">
          <h1 id="heading">{title}</h1>
          <p id="subtitle" className="subtitle sr" hidden={!presence}>
            {agent && presence ? (
              <>
                <span className="who">{`@${agent.handle}`}</span>
                <span className={`presence ${presence[1]}`.trim()}>{presence[0]}</span>
              </>
            ) : null}
          </p>
        </div>
        {conversation && !isNew ? (
          <button type="button" className="iconbtn" aria-label="Show details" aria-pressed={info} aria-keyshortcuts="I" title="Show details · I" onClick={() => setInfo((on) => !on)}>
            <DetailsIcon />
          </button>
        ) : (
          <span className="slot" aria-hidden="true" />
        )}
      </header>
      {conversation?.paused ? (
        <div className="banner pausebar" role="status">
          <span>Agents are paused after 20 messages in a row.</span>
          <button type="button" className="btn small" onClick={() => void resume(convId).catch((err) => setError((err && err.message) || "Something went wrong. Try again."))}>
            Resume
          </button>
        </div>
      ) : null}
      <div id="people" className="subbar" hidden={gone}>
        {chips.map((h) => (
          <span key={h} className="chip" role="img" aria-label={h}>
            <span className={`ava p${paletteOf(h)}`} aria-hidden="true">
              {initials(h)}
            </span>
          </span>
        ))}
      </div>
      <main className="chatmain">
        <section id="convo" className="convo" hidden={gone}>
          <Transcript
            messages={held?.list ?? NONE}
            pending={thread?.pending ?? NO_SENDS}
            hasEarlier={Boolean(held?.hasEarlier)}
            me={me}
            opened={opened}
            hint={isNew && !agent && !gone}
            conversation={convId}
            working={working ? `@${working.handle} is working…` : null}
            control={control}
            onEarlier={() => actions().loadEarlier(key)}
            onRetry={retry}
            onDetails={setInspected}
            focus={target || undefined}
          />
          <Composer agent={agent?.handle ?? null} label={label} onSend={send} textRef={textRef} mentions={isNew ? { crew, onPick: pick } : convId ? { crew } : undefined} />
        </section>
        <p id="chat-error" className="chat-error" role="alert" hidden={!error}>
          {error}
        </p>
      </main>
      <ThreadPane title={title} bubbles={(list, pending) => <ThreadBubbles messages={list} pending={pending} me={me} conversation={convId} onRetry={(cid) => useThreads.getState().retry(cid)} />} />
      {info && conversation ? <Details row={conversation} onClose={() => setInfo(false)} /> : null}
      {inspected ? <MessageDetails conversationId={convId} message={inspected} done={() => setInspected(null)} /> : null}
    </div>
  );

  function retry(cid: string) {
    actions().retry(key, cid);
  }
}

/** The most pages of earlier messages loaded to reach a message that a search result named (100 each). */
const MOST_PAGES = 50;

/** loadUntil loads earlier pages until the message is held, or there are no more, or the cap: a result may be old. */
async function loadUntil(s: ReturnType<typeof useConversations.getState>, key: string, convId: number, target: number): Promise<void> {
  for (let page = 0; page < MOST_PAGES; page++) {
    const held = data.store.getState().messages[convId];
    if (!held?.hasEarlier || held.list.some((m) => m.id <= target)) return;
    await s.loadEarlier(key);
  }
}

/** useFitFrame makes the frame follow the visible screen (iOS keeps the layout viewport under the keyboard). */
function useFitFrame(frame: RefObject<HTMLDivElement | null>) {
  const fit = useCallback(() => {
    const vv = window.visualViewport;
    const el = frame.current;
    if (!vv || !el) return;
    el.style.setProperty("--vv-h", `${vv.height}px`);
    el.style.setProperty("--vv-top", `${vv.offsetTop}px`);
    document.body.classList.toggle("kbd", vv.height < innerHeight - 80);
  }, [frame]);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    addEventListener("resize", fit);
    fit();
    return () => {
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      removeEventListener("resize", fit);
    };
  }, [fit]);
  return fit;
}
