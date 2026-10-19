import { mentionsOf } from "@convoz/markdown";
import type { Identity, Message, Upload } from "@convoz/api-client";
import { AttachIcon, BackIcon, DetailsIcon } from "@convoz/ui/icons";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from "react";
import { ApiError } from "../../shared/api.ts";
import { initials, paletteOf, setRegistry, stripCf } from "../../shared/chat.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { CallBar, CallButton } from "../call/index.ts";
import { Composer, useAttachments } from "../composer/index.ts";
import { InviteAgentSheet } from "../crew/index.ts";
import { usePlans } from "../plan/index.ts";
import { StarButton } from "../pins-stars/index.ts";
import { rememberChat } from "../search/index.ts";
import { ThreadPane, useThreads } from "../threads/index.ts";
import { resume } from "./actions.ts";
import { Details } from "./Details.tsx";
import { MessageDetails } from "./MessageDetails.tsx";
import { OpenDetails } from "./messages/PlanNote.tsx";
import { PlanLine } from "./PlanLine.tsx";
import { useFocusReport } from "../notifications/index.ts";
import { replyingNote, usePresence, useReplying } from "../../shared/presence.ts";
import { backLabel, useBackCount } from "./backCount.ts";
import { useConversations, type PendingSend } from "./store.ts";
import { keyboardOpen, virtualKeyboard, type Screen } from "./keyboard.ts";
import { firstUnread, ThreadBubbles, Transcript, type TranscriptControl } from "./Transcript.tsx";

const NEW = "new";
const GONE = "This conversation does not exist, or it is not yours.";
const NONE: Message[] = [];
const NO_SENDS: PendingSend[] = [];

/**
 * Conversation is /chats/:id and /chats/new: a full-screen chat with Back and the agent in the top bar, the log, and the
 * composer pinned to the bottom of the visible screen. New conversation starts blank; "@" brings in an agent, and the first
 * send makes the conversation and moves the URL to it.
 */
/** Now's "Reply in thread" lands on a conversation with #reply=<ask id>: open that thread. */
function openReplyLink(conv: number): void {
  const reply = Number(/^#reply=(\d+)$/.exec(location.hash)?.[1] ?? 0);
  if (reply) void useThreads.getState().openThread(conv, reply);
}

export function Conversation() {
  const [isNew] = useState(() => location.pathname === "/chats/new");
  const [key] = useState(() => (isNew ? NEW : location.pathname.split("/")[2]!));
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
  // Where unread began when the chat opened: kept for as long as it stays open, so the divider does not follow the read position.
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  // /chats/<id>#plan (a row of Now) opens with the plan panel showing.
  const [info, setInfo] = useState(() => location.hash === "#plan");
  const openInfo = useCallback(() => setInfo(true), []);
  const [inviting, setInviting] = useState(false);
  const [inspected, setInspected] = useState<Message | null>(null);
  const [dragging, setDragging] = useState(false);
  const attachments = useAttachments(convId);
  const threadOpen = useThreads((s) => s.open !== null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const control = useRef<TranscriptControl>(null);
  // A search result opens the conversation at its message: /chats/<id>#m<message id>.
  const [target] = useState(() => Number(/^#m(\d+)$/.exec(location.hash)?.[1] ?? 0));
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

  // The same link followed while this conversation is already open changes only the hash: no reload, so the load effect does not run.
  useEffect(() => {
    if (!convId) return;
    const follow = () => {
      if (location.hash === "#plan") setInfo(true);
      openReplyLink(convId);
      const wanted = Number(/^#m(\d+)$/.exec(location.hash)?.[1] ?? 0);
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
          s.startThread(NEW, [wanted.handle]);
          setPicked([wanted.handle]);
          openWith(wanted.handle);
        } else {
          s.startThread(NEW, []);
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
      openReplyLink(id);
      rememberChat(id);
      const who = data.store.getState().rows[id]!.participants.find((p) => p.kind === "agent") ?? { handle: "agent" };
      setAgentHandle(who.handle);
      fit();
      const held = data.store.getState();
      setNewFrom(firstUnread(held.messages[id]?.list ?? NONE, held.rows[id]?.last_read, held.me?.identity.handle ?? ""));
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
    const sameSite = document.referrer.startsWith(location.origin + "/");
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
      actions().startThread(NEW, [...new Set([...picked, ...typed])]);
    }
    actions().send(key, body, files, held);
  };

  // Files dragged onto the conversation attach to the message being written (a new conversation holds them until its first send).
  const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files") || event.dataTransfer?.files.length);
  const dragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const drop = (event: DragEvent) => {
    setDragging(false);
    if (!carriesFiles(event)) return;
    event.preventDefault();
    attachments.add(Array.from(event.dataTransfer.files));
  };

  const pick = (who: Identity) => {
    const next = picked.includes(who.handle) ? picked : [...picked, who.handle];
    setPicked(next);
    actions().startThread(NEW, next);
    setAgentHandle(next[0]!);
    fit();
  };

  const presence = !agent ? null : working ? ["Working…", "busy"] : agent.online ? ["Online", "on"] : ["Offline", ""];
  const chips = !conversation ? picked : agents.map((p) => p.handle);
  const label = !agent ? "Message" : (conversation ? agents.length : picked.length) > 1 ? "Message" : `Message @${agent.handle}`;

  return (
    <div className="chatframe" id="frame" ref={frame}>
      <header className="appbar chatbar">
        <a id="back" className="iconbtn" href="/chats" aria-label={backLabel(waiting)} onClick={back}>
          <BackIcon />
          {waiting > 0 ? (
            <span className="backbadge" aria-hidden="true">
              {waiting > 99 ? "99+" : waiting}
            </span>
          ) : null}
        </a>
        <div className="titles">
          <h1 id="heading">{title}</h1>
          {conversation?.muted_until ? <span className="mutedtag">Muted</span> : null}
          {attention ? <PlanLine attention={attention} onOpen={() => setInfo(true)} /> : null}
          <p id="subtitle" className="subtitle" hidden={!presence || Boolean(attention)}>
            {agent && presence ? (
              <>
                <span className="who">{`@${agent.handle}`}</span>
                <span className={`presence ${presence[1]}`.trim()}>{presence[0]}</span>
              </>
            ) : null}
          </p>
        </div>
        {conversation && !isNew ? <CallButton conversationId={convId} /> : null}
        {conversation && !isNew ? <StarButton id={convId} starred={conversation.starred} /> : null}
        {conversation && !isNew ? (
          <button type="button" className="iconbtn" aria-label="Show details" aria-pressed={info} aria-keyshortcuts="I" title="Show details · I" onClick={() => setInfo((on) => !on)}>
            <DetailsIcon />
          </button>
        ) : (
          <span className="slot" aria-hidden="true" />
        )}
      </header>
      {convId ? <CallBar conversationId={convId} /> : null}
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
        <section
          id="convo"
          className="convo"
          aria-label="Conversation"
          hidden={gone}
          onDragEnter={dragOver}
          onDragOver={dragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={drop}
        >
          {dragging ? (
            <div className="dropov" aria-hidden="true">
              <span>
                <AttachIcon />
                Drop to attach
              </span>
            </div>
          ) : null}
          <OpenDetails.Provider value={openInfo}>
            <Transcript
              messages={held?.list ?? NONE}
              pending={thread?.pending ?? NO_SENDS}
              hasEarlier={Boolean(held?.hasEarlier)}
              me={me}
              opened={opened}
              hint={isNew && !agent && !gone}
              conversation={convId}
              working={note}
              control={control}
              onEarlier={() => actions().loadEarlier(key)}
              onRetry={retry}
              onDetails={setInspected}
              focus={focus || undefined}
              newFrom={newFrom}
            />
          </OpenDetails.Provider>
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
      <ThreadPane title={title} bubbles={(list, pending) => <ThreadBubbles messages={list} pending={pending} me={me} conversation={convId} onRetry={(cid) => useThreads.getState().retry(cid)} />} />
      {info && conversation ? <Details row={conversation} onClose={() => setInfo(false)} onInvite={() => setInviting(true)} board={board} act={{ say: (text) => send(text, []), reply: compose }} /> : null}
      {inviting && convId ? (
        <Suspense fallback={null}>
          <InviteAgentSheet close={() => setInviting(false)} conversation={{ id: convId, title: stripCf(conversation?.title ?? "") }} />
        </Suspense>
      ) : null}
      {inspected ? <MessageDetails conversationId={convId} message={inspected} done={() => setInspected(null)} /> : null}
    </div>
  );

  /** compose starts a message in the box (the panel's Reply): the box is the composer's own state, so it is set the way typing sets it. */
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
