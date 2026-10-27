import { IconButton } from "@convoz/ui/IconButton";
import { mentionsOf } from "@convoz/markdown";
import type { Identity, Message, Upload } from "@convoz/api-client";
import { BackIcon, DetailsIcon } from "@convoz/ui/icons";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { ApiError } from "../../shared/api.ts";
import { initials, newId, paletteOf, setRegistry, stripCf } from "../../shared/chat.ts";
import { data, offlineReady, useData, useLive } from "../../shared/data.ts";
import { navigatedInApp } from "../../shared/navigate.ts";
import { CallBar, CallButton } from "../call/index.ts";
import { Composer, useAttachments, useFileDrop } from "../composer/index.ts";
import { InviteAgentSheet } from "../crew/index.ts";
import { usePlans } from "../plan/index.ts";
import { StarButton } from "../pins-stars/index.ts";
import { rememberChat } from "../search/index.ts";
import { useThreads } from "../threads/index.ts";
import { Details } from "./Details.tsx";
import { MessageDetails } from "./MessageDetails.tsx";
import { PlanLine } from "./PlanLine.tsx";
import type { PlanActions } from "./PlanSections.tsx";
import { useFocusReport } from "../notifications/index.ts";
import { replyingNote, usePresence, useReplying } from "../../shared/presence.ts";
import { backLabel, useBackCount } from "./backCount.ts";
import { useConversations, type PendingSend } from "./store.ts";
import { keyboardOpen, virtualKeyboard, type Screen } from "./keyboard.ts";
import { firstUnread, Transcript, type TranscriptControl } from "./Transcript.tsx";

const GONE = "This conversation does not exist, or it is not yours.";
const NONE: Message[] = [];
const NO_SENDS: PendingSend[] = [];

/** The root a #reply=<id> link names (Now's "Reply in thread", a thread row of the list, a thread search result), 0 for none. */
const replyLink = (): number => Number(/^#reply=(\d+)$/.exec(location.hash)?.[1] ?? 0);
/** The hashes that open the details panel: #plan, and #plan-<handle> on that agent's card. */
const PLAN_HASH = /^#plan(-[a-z0-9-]+)?$/;

/**
 * Conversation is /chats/:id and /chats/new: a full-screen chat with Back and the agent in the top bar, the log, and the
 * composer pinned to the bottom of the visible screen. New conversation starts blank; "@" brings in an agent, and the first
 * send makes the conversation and moves the URL to it.
 */
export function Conversation() {
  const [isNew] = useState(() => location.pathname === "/chats/new");
  // Each New conversation page has its own key: a page left with a send in flight keeps it, and the next New conversation starts blank.
  const [key] = useState(() => (isNew ? `new-${newId()}` : location.pathname.split("/")[2]!));
  const thread = useConversations((s) => s.threads[key]);
  const convId = thread?.convId ?? 0;
  const conversation = useData((s) => (convId ? s.rows[convId] : undefined));
  useFocusReport(convId || undefined); // a push for the chat on screen is held back
  const held = useData((s) => (convId ? s.messages[convId] : undefined));
  const me = useData((s) => s.me?.identity.handle ?? "");
  const people = useData((s) => s.identities);
  const actions = useConversations.getState;
  const [agentHandle, setAgentHandle] = useState<string | null>(null);
  // New conversation: the agents picked from the @ list so far (their handles are in the message too).
  const [picked, setPicked] = useState<string[]>([]);
  const [opened, setOpened] = useState(false);
  const [current, setCurrent] = useState(false);
  // Where unread began when the chat opened: kept for as long as it stays open, so the divider does not follow the read position.
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  // /chats/<id>#plan, or #plan-<handle> (the pill of a plan update), opens with the plan panel showing.
  const [info, setInfo] = useState(() => PLAN_HASH.test(location.hash));
  const [inviting, setInviting] = useState(false);
  const [inspected, setInspected] = useState<Message | null>(null);
  const attachments = useAttachments(convId);
  // Files dragged onto the conversation attach to the message being written (a new conversation holds them until its first send).
  const fileDrop = useFileDrop(attachments);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const control = useRef<TranscriptControl>(null);
  // A search result opens the conversation at its message: /chats/<id>#m<message id>; a reply link at the root of its thread.
  const [target] = useState(() => Number(/^#m(\d+)$/.exec(location.hash)?.[1] ?? 0) || replyLink());
  // The message the log is scrolled to now: the one the link named, then each later search result for this same conversation.
  const [focus, setFocus] = useState(target);

  const crew = useMemo(() => (people ?? []).filter((p) => p.kind === "agent" && !p.disabled), [people]);
  const agents = (conversation?.participants ?? []).filter((p) => p.kind === "agent");
  const agentName = agentHandle ?? agents[0]?.handle ?? null; // a conversation made from typed mentions has no pick
  const agent = agentName ? { handle: agentName, online: Boolean(people?.find((p) => p.handle === agentName)?.online) } : null;
  const replying = useReplying(convId, 0);
  const anywhere = useReplying(convId);
  const working = Boolean(agent && anywhere.includes(agent.handle));
  // An existing chat is "Conversation" until its row is in; an untitled one is "New conversation".
  const title = gone ? "Conversation not found" : !isNew && !conversation ? "Conversation" : stripCf(conversation?.title ?? "") || "New conversation";

  useEffect(() => {
    document.title = `${title} - Convoz`;
  }, [title]);

  const waiting = useBackCount(convId);
  const board = usePlans((s) => (convId ? s.boards[convId] : undefined));
  const attention = board?.attention.find((a) => a.conversation_id === convId);
  const fit = useFitFrame(frame);

  // The threads drawn under the messages belong to this page.
  useEffect(() => () => useThreads.getState().reset(), []);

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

  // "Reply" on the digest of Now lands here with #compose: the composer has the focus.
  useEffect(() => {
    if (opened && location.hash === "#compose") textRef.current?.focus();
  }, [opened]);

  // The same link followed while this conversation is already open changes only the hash: no reload, so the load effect does not run.
  useEffect(() => {
    if (!convId) return;
    const follow = () => {
      if (PLAN_HASH.test(location.hash)) {
        setInfo(true);
        // The panel draws on this render: the card of #plan-<handle> is there on the next frame.
        requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "nearest" }));
      }
      if (location.hash === "#compose") textRef.current?.focus();
      const root = replyLink();
      if (root) useThreads.getState().startReply(convId, root);
      const wanted = Number(/^#m(\d+)$/.exec(location.hash)?.[1] ?? 0) || root;
      if (!wanted) return;
      setFocus(0); // the same message chosen twice must scroll and mark again
      void loadUntil(actions(), key, convId, wanted).then(() => setFocus(wanted));
    };
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, [convId, key, actions]);

  const openWith = useCallback(
    (handle: string) => {
      setAgentHandle(handle);
      fit();
      textRef.current?.focus();
    },
    [fit],
  );

  // Open: the conversation draws from the offline copy; who I am and the crew come in the background (or, for the blank new one, first).
  useEffect(() => {
    let alive = true; // the owner may leave before the server answers: nothing is marked read for a page that is gone
    const failed = (err: unknown) => {
      if (!alive) return;
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        setError(GONE);
        return;
      }
      if (err instanceof ApiError && err.handled) return;
      setError((err instanceof Error && err.message) || "Something went wrong. Try again.");
    };
    (async () => {
      const s = actions();
      // At once, not after the crew: the offline copy lets the owner pick and send before the server answers (owner report, conv 359 msg 6385).
      if (isNew) s.startThread(key, []);
      const crew = Promise.all([data.loadMe(), data.loadIdentities()]).then(([, everyone]) => (setRegistry(everyone), everyone));
      crew.catch(() => {}); // a conversation never waits for it; only the new one awaits it, and sees its failure
      await offlineReady();
      const known = data.store.getState().identities;
      if (known) setRegistry(known); // avatars and colors are right on the first draw
      if (isNew) {
        const everyone = await crew;
        textRef.current?.focus(); // the gradient ring shows at once, as in the prototype
        const wanted = everyone.find((p) => p.kind === "agent" && !p.disabled && p.handle === new URLSearchParams(location.search).get("with"));
        const started = actions().threads[key];
        if (wanted && !started?.convId && !started?.pending.length) {
          s.startThread(key, [wanted.handle]);
          setPicked([wanted.handle]);
          openWith(wanted.handle);
        }
        setCurrent(true);
        return;
      }
      const id = Number(key);
      const { fresh } = await s.openThread(key, id);
      if (target) await loadUntil(s, key, id, target);
      const root = replyLink();
      if (root) useThreads.getState().startReply(id, root);
      rememberChat(id);
      const who = data.store.getState().rows[id]!.participants.find((p) => p.kind === "agent") ?? { handle: "agent" };
      setAgentHandle(who.handle);
      fit();
      setOpened(true);
      // Where unread began comes from the server's answer: a held copy's read mark can be old, and marking read first would move it.
      Promise.all([fresh, crew.catch(() => {})]).then(() => {
        if (!alive) return;
        setCurrent(true);
        const held = data.store.getState();
        setNewFrom(firstUnread(held.messages[id]?.list ?? NONE, held.rows[id]?.last_read, held.me?.identity.handle ?? ""));
        void s.markRead(key);
        // The answer can reshape rows above a log that opened at the newest end (the line, names, a longer page): it stays there.
        if (!target && !root) {
          control.current?.stick();
          requestAnimationFrame(() => control.current?.followIfStuck());
        }
      }, failed);
    })().catch(failed);
    return () => {
      alive = false;
    };
  }, [isNew, key, openWith, fit, actions, target]);

  // The first send made the conversation: the URL names it now.
  useEffect(() => {
    if (isNew && convId) history.replaceState(null, "", `/chats/${convId}`);
  }, [isNew, convId]);

  // The plans of this conversation: the line under the title and the panel. The stream keeps them fresh (features/plan).
  useEffect(() => {
    if (convId && !isNew) void usePlans.getState().load(convId).catch(() => {});
  }, [convId, isNew]);

  useLive(() => {
    if (convId) void usePlans.getState().load(convId).catch(() => {});
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

  // The replying note: shown until a message from the agent, a stop frame, or its `until` (shared/presence.ts).
  const note = replyingNote(replying);
  useEffect(() => {
    if (note) control.current?.followIfStuck();
  }, [note]);

  // Who has seen the owner's newest message is stored with the conversation: take it in when the row comes.
  useEffect(() => {
    if (convId) usePresence.getState().hydrate(convId, 0, conversation?.seen);
  }, [convId, conversation?.seen]);

  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    const sameSite = navigatedInApp() || document.referrer.startsWith(location.origin + "/");
    if (history.length > 1 && sameSite) {
      event.preventDefault();
      history.back();
    }
  };

  const send = (body: string, files: Upload[], held: File[] = []) => {
    control.current?.stick();
    const t = actions().threads[key];
    if (isNew && t && !t.convId && t.pending.length === 0) {
      // the conversation is made with the agents picked and the ones typed into the message
      const typed = mentionsOf(body).filter((h) => crew.some((p) => p.handle === h));
      actions().startThread(key, [...new Set([...picked, ...typed])]);
    }
    actions().send(key, body, files, held);
  };

  const pick = (who: Identity) => {
    const next = picked.includes(who.handle) ? picked : [...picked, who.handle];
    setPicked(next);
    actions().startThread(key, next);
    setAgentHandle(next[0]!);
    fit();
  };

  const presence = !agent ? null : working ? ["Working…", "busy"] : agent.online ? ["Online", "on"] : ["Offline", ""];
  const chips = !conversation ? picked : agents.map((p) => p.handle);
  const label = !agent ? "Message" : (conversation ? agents.length : picked.length) > 1 ? "Message" : `Message @${agent.handle}`;
  const act: PlanActions = { say: (text) => send(text, []), reply: compose };

  return (
    <div className="chatframe" id="frame" ref={frame}>
      <header className="appbar chatbar">
        <IconButton id="back" variant="float" href="/chats" label={backLabel(waiting)} onClick={back}>
          <BackIcon />
          {waiting > 0 ? (
            <span className="backbadge" aria-hidden="true">
              {waiting > 99 ? "99+" : waiting}
            </span>
          ) : null}
        </IconButton>
        <div className="titles">
          <h1 id="heading">{title}</h1>
          {conversation?.muted_until ? <span className="mutedtag">Muted</span> : null}
          {attention ? <PlanLine attention={attention} onOpen={() => setInfo(true)} /> : null}
          <p id="subtitle" className="subtitle" hidden={!presence || Boolean(attention)}>
            {agent && presence ? (
              <>
                <a className="who" href={`/crew/${encodeURIComponent(agent.handle)}`}>{`@${agent.handle}`}</a>
                <span className={`presence ${presence[1]}`.trim()}>{presence[0]}</span>
              </>
            ) : null}
          </p>
        </div>
        {/* not gated on isNew: that is the URL at mount, and the first send makes /chats/new a real conversation without a reload (issue 62) */}
        {conversation ? <CallButton conversationId={convId} /> : null}
        {conversation ? <StarButton id={convId} starred={conversation.starred} /> : null}
        {conversation ? (
          <IconButton variant="float" label="Show details" aria-pressed={info} aria-keyshortcuts="I" title="Show details · I" onClick={() => setInfo((on) => !on)}>
            <DetailsIcon />
          </IconButton>
        ) : (
          <span className="slot" aria-hidden="true" />
        )}
      </header>
      {convId ? <CallBar conversationId={convId} /> : null}
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
        <section
          id="convo"
          className="convo"
          aria-label="Conversation"
          hidden={gone}
          {...fileDrop.handlers}
        >
          {fileDrop.overlay}
          <Transcript
            messages={held?.list ?? NONE}
            pending={thread?.pending ?? NO_SENDS}
            hasEarlier={Boolean(held?.hasEarlier)}
            me={me}
            opened={opened}
            current={current}
            hint={isNew && !agent && !gone}
            conversation={convId}
            working={note}
            control={control}
            onEarlier={() => actions().loadEarlier(key)}
            onRetry={retry}
            onDiscard={(cid) => actions().discard(key, cid)}
            onDetails={setInspected}
            focus={focus || undefined}
            newFrom={newFrom}
          />
          <Composer
            agent={agent?.handle ?? null}
            label={label}
            conversationId={convId}
            attachments={attachments}
            onSend={send}
            textRef={textRef}
            mentions={isNew && !convId ? { crew, onPick: pick } : convId ? { crew, onInvite: () => setInviting(true) } : undefined}
          />
        </section>
        <p id="chat-error" className="chat-error" role="alert" hidden={!error}>
          {error}
        </p>
      </main>
      {info && conversation ? <Details row={conversation} onClose={() => setInfo(false)} onInvite={() => setInviting(true)} board={board} act={act} /> : null}
      {inviting && convId ? (
        <Suspense fallback={null}>
          <InviteAgentSheet close={() => setInviting(false)} conversation={{ id: convId, title: stripCf(conversation?.title ?? "") }} />
        </Suspense>
      ) : null}
      {inspected ? <MessageDetails conversationId={convId} message={inspected} done={() => setInspected(null)} /> : null}
    </div>
  );

  /** compose starts a message in the box (Reply on a plan card): the box is the composer's own state, so it is set the way typing sets it. */
  function compose(text: string) {
    setInfo(false);
    const box = textRef.current;
    if (!box) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
  }

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

/**
 * useFitFrame makes the frame follow the visible screen (iOS keeps the layout viewport under the keyboard) and marks the body "kbd"
 * while a phone's keyboard is open, which shrinks the header to one line (see keyboard.ts).
 */
function useFitFrame(frame: RefObject<HTMLDivElement | null>) {
  const screen = useRef<Screen>({ width: 0, height: 0 });
  const fit = useCallback(() => {
    const vv = window.visualViewport;
    const el = frame.current;
    if (!vv || !el) return;
    el.style.setProperty("--vv-h", `${vv.height}px`);
    el.style.setProperty("--vv-top", `${vv.offsetTop}px`);
    document.body.classList.toggle("kbd", keyboardOpen(vv, screen.current));
  }, [frame]);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const vk = virtualKeyboard();
    // focus moves between two fields through a moment with none focused: the keyboard is judged after it
    const blurred = () => void setTimeout(fit, 0);
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    vk?.addEventListener("geometrychange", fit);
    addEventListener("resize", fit);
    addEventListener("focusin", fit);
    addEventListener("focusout", blurred);
    fit();
    return () => {
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      vk?.removeEventListener("geometrychange", fit);
      removeEventListener("resize", fit);
      removeEventListener("focusin", fit);
      removeEventListener("focusout", blurred);
      document.body.classList.remove("kbd");
    };
  }, [fit]);
  return fit;
}
