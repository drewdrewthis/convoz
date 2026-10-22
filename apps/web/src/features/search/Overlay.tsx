import type { SearchPart, SearchResponse } from "@convoz/api-client";
import { SearchIcon } from "@convoz/ui/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { call, client } from "../../shared/api.ts";
import { initials, paletteOf, stripCf, whenLabel } from "../../shared/chat.ts";
import { data, useData } from "../../shared/data.ts";
import { navigate } from "../../shared/navigate.ts";
import { nowCallLive, startNowCall, useVoiceOn } from "../call/index.ts";
import { recentChats } from "./recent.ts";
import { useSearchUi } from "./store.ts";

/** Rows a group shows before "Show all". */
const GROUP_ROWS = 5;
/** Messages asked for at once; the groups show the newest of them. */
const ASKED = 50;

const FILTERS_HELP = "Filters: @from  in:conversation  is:ask  is:starred  is:pinned  is:app  has:file  has:link";

type Badge = { kind: "avatar"; handle: string; you?: boolean } | { kind: "icon"; path: string };

interface Row {
  id: string;
  title: SearchPart[];
  sub?: SearchPart[];
  tag?: string;
  /** The tag is the accent colour ("Open"), not the quiet one. */
  loud?: boolean;
  badge?: Badge;
  /** A row of the list that is not a result: it is not searched text, so nothing in it is marked. */
  run(): void;
}

interface Section {
  key: string;
  label: string;
  count: string;
  rows: Row[];
}

// The prototype's icons for the rows that have no avatar.
const ICON_CHAT = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";
const ICON_ASK = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01";
const ICON_NEW = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z";
const ICON_CREW = "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75";
const ICON_MORE = "M6 9l6 6 6-6";
const ICON_CALL = "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z";

const plainParts = (text: string): SearchPart[] => (text ? [{ text }] : []);

/** tokensOf splits the text as the server does: a filter with a quoted value is one token. */
const tokensOf = (q: string): string[] => q.match(/(?:in|from):"[^"]*"|"[^"]*"|\S+/gi) ?? [];

/** pickingAgent is the text after a lone "@": then the box lists the agents to start a conversation with. A space after it searches with the from filter. */
const pickingAgent = (q: string): string | null => /^@(\S*)$/.exec(q.trimStart())?.[1]?.toLowerCase() ?? null;

/** The search overlay: one box over agents, conversations, messages and asks, with the filters as chips. */
export default function Overlay() {
  const hide = useSearchUi((s) => s.hide);
  const me = useData((s) => s.me?.identity.handle);
  const identities = useData((s) => s.identities);
  const conversations = useData((s) => s.conversations);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [all, setAll] = useState<Record<string, boolean>>({});
  const pick = pickingAgent(q);
  const found = useAnswer(pick === null ? q : "");
  const wide = useWide();
  const voice = useVoiceOn();

  useEffect(() => {
    input.current?.focus();
    data.loadMe().catch(() => {});
    data.loadIdentities().catch(() => {});
    data.loadConversations().catch(() => {});
  }, []);

  // Every choice closes the overlay itself: going to the page already on screen is no navigation, so nothing else would close it.
  const open = (href: string) => {
    hide();
    const [path = "", hash = ""] = href.split("#");
    // A document load would end a Now call, so while one is on the app draws the page itself.
    if (location.pathname !== path) return nowCallLive() ? navigate(href) : location.assign(href);
    const same = location.hash === (hash && `#${hash}`);
    location.hash = hash;
    // The same hash again fires no hashchange, and the page listens to that event to open a thread or scroll to a message.
    if (same && hash) dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const browse = q.trim() === "";
  const chips = found.answer?.filters ?? [];
  const terms = useMemo(() => tokensOf(q).filter((t) => !chips.some((c) => c.token === t)).map((t) => t.replace(/"/g, "").toLowerCase()).filter(Boolean), [q, chips]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const group = (key: string, label: string, list: Row[]) => {
      if (!list.length) return;
      const shown = all[key] ? list : list.slice(0, GROUP_ROWS);
      const rows = [...shown];
      if (shown.length < list.length) {
        rows.push({ id: `more-${key}`, title: plainParts(`Show all ${list.length}`), badge: { kind: "icon", path: ICON_MORE }, run: () => setAll((a) => ({ ...a, [key]: true })) });
      }
      out.push({ key, label, count: String(list.length), rows });
    };
    const agentRow = (p: NonNullable<typeof identities>[number], words: string[]): Row => ({
      id: `agent-${p.handle}`,
      title: marked(p.handle, words),
      sub: plainParts(p.display_name),
      tag: p.online ? "Online" : "Offline",
      badge: { kind: "avatar", handle: p.handle },
      run: () => open(`/chats/new?with=${encodeURIComponent(p.handle)}`),
    });
    if (pick !== null) {
      // A disabled agent is left out: the new conversation would not take it.
      const agents = (identities ?? []).filter((p) => p.kind === "agent" && !p.disabled && `${p.handle} ${p.display_name}`.toLowerCase().includes(pick));
      const rows = agents.sort((a, b) => Number(b.handle.startsWith(pick)) - Number(a.handle.startsWith(pick))).map((p) => agentRow(p, [pick]));
      if (rows.length) out.push({ key: "agents", label: "Start a conversation with", count: String(rows.length), rows });
      return out;
    }
    if (browse) {
      const byId = new Map((conversations ?? []).map((c) => [c.id, c]));
      const recent = recentChats()
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map<Row>((c) => ({
          id: `recent-${c.id}`,
          title: plainParts(stripCf(c.title ?? "") || "New conversation"),
          sub: plainParts(c.last ? stripCf(c.last.preview) : "No messages yet"),
          tag: "Conversation",
          badge: { kind: "icon", path: ICON_CHAT },
          run: () => open(`/chats/${c.id}`),
        }));
      if (recent.length) out.push({ key: "recent", label: "Recent", count: "", rows: recent });
      const quick: Row[] = [
        { id: "quick-new", title: plainParts("New conversation"), sub: plainParts("Starts blank. Type @ to bring in an agent"), tag: "⌘J", badge: { kind: "icon", path: ICON_NEW }, run: () => open("/chats/new") },
        { id: "quick-crew", title: plainParts("Crew"), sub: plainParts("Every agent and what it is doing"), badge: { kind: "icon", path: ICON_CREW }, run: () => open("/crew") },
      ];
      // The tap itself starts the call: the microphone may only be asked for inside it (features/call/gesture.ts).
      if (voice) {
        quick.push({
          id: "quick-call",
          title: plainParts("Call"),
          sub: plainParts("Hear what waits on you, by voice"),
          badge: { kind: "icon", path: ICON_CALL },
          run: () => {
            hide();
            startNowCall();
          },
        });
      }
      out.push({ key: "quick", label: "Quick actions", count: "", rows: quick });
      return out;
    }
    const answer = found.answer;
    if (!answer) return out;
    if (!chips.length) {
      const agents = (identities ?? []).filter((p) => p.kind === "agent" && terms.every((w) => `${p.handle} ${p.display_name}`.toLowerCase().includes(w)));
      group(
        "agents",
        "Agents",
        agents
          .sort((a, b) => Number(b.handle.startsWith(terms[0] ?? "")) - Number(a.handle.startsWith(terms[0] ?? "")))
          .map((p) => agentRow(p, terms)),
      );
    }
    group(
      "chats",
      "Conversations",
      answer.conversations.map((c) => ({
        id: `chat-${c.id}`,
        title: c.snippet.map(clean),
        sub: plainParts(c.preview || "No messages yet"),
        tag: c.starred ? "Starred" : "Conversation",
        badge: { kind: "icon", path: ICON_CHAT },
        run: () => open(`/chats/${c.id}`),
      })),
    );
    const place = (r: SearchResponse["results"][number]) => `${r.author.handle === me ? "You" : r.author.handle} · ${stripCf(r.conversation_title) || "New conversation"} · ${whenLabel(r.created_at)}`;
    // A reply is not in the main list: its result opens the thread it hangs from.
    const toMessage = (r: SearchResponse["results"][number]) => open(r.thread_root_id ? `/chats/${r.conversation_id}#reply=${r.thread_root_id}` : `/chats/${r.conversation_id}#m${r.message_id}`);
    group(
      "msgs",
      "Messages",
      answer.results
        .filter((r) => r.kind !== "ask")
        .map((r) => ({
          id: `msg-${r.message_id}`,
          title: r.snippet.map(clean),
          sub: plainParts(place(r)),
          badge: { kind: "avatar", handle: r.author.handle, you: r.author.handle === me },
          run: () => toMessage(r),
        })),
    );
    group(
      "asks",
      "Asks",
      answer.results
        .filter((r) => r.kind === "ask")
        .map((r) => ({
          id: `ask-${r.message_id}`,
          title: r.snippet.map(clean),
          sub: plainParts(place(r)),
          tag: "Ask",
          loud: true,
          badge: { kind: "icon", path: ICON_ASK },
          run: () => toMessage(r),
        })),
    );
    return out;
  }, [pick, browse, found.answer, chips, terms, all, identities, conversations, me, voice]);

  const flat = sections.flatMap((s) => s.rows);
  const active = Math.min(at, Math.max(flat.length - 1, 0));
  const total = (found.answer?.results.length ?? 0) + (found.answer?.conversations.length ?? 0);

  useEffect(() => {
    document.getElementById(`sr-${flat[active]?.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, flat]);

  const onKey = (event: KeyboardEvent) => {
    const move = (d: number) => {
      event.preventDefault();
      if (flat.length) setAt((active + d + flat.length) % flat.length);
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter") {
      event.preventDefault();
      flat[active]?.run();
    } else if (event.key === "Tab") event.preventDefault(); // the box is the only control that takes the keyboard
  };

  const type = (value: string) => {
    setQ(value);
    setAt(0);
    setAll({});
  };
  const clear = (token: string) => {
    const rest = tokensOf(q).filter((t) => t !== token).join(" ");
    type(rest ? `${rest} ` : "");
    input.current?.focus();
  };

  return (
    <div className="srhost">
      <button type="button" className="srscrim" aria-label="Close search" tabIndex={-1} onClick={hide} />
      <div className="srdlg glass" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKey}>
        <div className="srbar">
          <label className="fld" htmlFor="search-q">
            <span className="sr">Search</span>
            <SearchIcon />
            <input
              id="search-q"
              ref={input}
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls="sr-list"
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? `sr-${flat[active]!.id}` : undefined}
              enterKeyHint="search"
              placeholder={wide ? "Search agents, messages, files, asks" : "Search"}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={q}
              onChange={(e) => type(e.target.value)}
            />
          </label>
          <button type="button" className="srcancel" onClick={hide}>
            Cancel
          </button>
        </div>
        {chips.length ? (
          <div className="srchips" role="group" aria-label="Active filters">
            {chips.map((c) => (
              <button key={c.token} type="button" className="srchip" aria-label={`Remove filter: ${c.label}`} onMouseDown={(e) => e.preventDefault()} onClick={() => clear(c.token)}>
                {c.label}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            ))}
          </div>
        ) : null}
        <div id="sr-list" className="srlist" role="listbox" aria-label="Search results">
          {sections.map((s) => (
            <div key={s.key} className="srgroup" role="group" aria-label={s.label}>
              <div className="srhead">
                <span>{s.label}</span>
                <span>{s.count}</span>
              </div>
              {s.rows.map((r) => (
                <RowView key={r.id} row={r} on={flat[active] === r} onPick={() => r.run()} />
              ))}
            </div>
          ))}
          {pick !== null && identities && flat.length === 0 ? <p className="srnone">{`No agent matches “@${pick}”.`}</p> : null}
          {pick === null && !browse && found.answer && flat.length === 0 ? <p className="srnone">{`No results for “${q.trim()}”. Try fewer words or remove a filter.`}</p> : null}
          {found.error ? <p className="srnone">Search did not answer. Try again.</p> : null}
        </div>
        <div className="srmeta">
          <span role="status" aria-live="polite">
            {pick !== null ? "Enter starts a conversation with the agent" : browse ? FILTERS_HELP : found.answer ? `${total} ${total === 1 ? "result" : "results"} · ${found.ms < 10 ? found.ms.toFixed(1) : Math.round(found.ms)} ms` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

function RowView({ row, on, onPick }: { row: Row; on: boolean; onPick(): void }) {
  return (
    <button type="button" role="option" id={`sr-${row.id}`} aria-selected={on} tabIndex={-1} className="srrow" onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <Badge badge={row.badge} />
      <span className="srtxt">
        <span className="srtitle">{parts(row.title)}</span>
        {row.sub?.length ? <span className="srsub">{parts(row.sub)}</span> : null}
      </span>
      {row.tag ? <span className={`srtag${row.loud ? " loud" : ""}`}>{row.tag}</span> : null}
    </button>
  );
}

function Badge({ badge }: { badge?: Badge }) {
  if (badge?.kind === "avatar") {
    return badge.you ? <span className="ava you srbadge" aria-hidden="true" data-l="Y" /> : <span className={`ava p${paletteOf(badge.handle)} srbadge`} aria-hidden="true" data-l={initials(badge.handle)} />;
  }
  return (
    <span className="srbadge icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d={badge?.kind === "icon" ? badge.path : ""} />
      </svg>
    </span>
  );
}

/** parts draws a snippet; a matched word is a <mark> (bold and tinted, so colour is never the only cue). */
function parts(list: SearchPart[]): ReactNode {
  return list.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
}

const clean = (p: SearchPart): SearchPart => ({ ...p, text: stripCf(p.text) });

/** marked is a text with every term of the query that starts one of its words marked. */
function marked(text: string, terms: string[]): SearchPart[] {
  const low = text.toLowerCase();
  const hit = terms.find((w) => w && low.startsWith(w));
  return hit ? [{ text: text.slice(0, hit.length), hit: true }, { text: text.slice(hit.length) }] : plainParts(text);
}

/** useWide tells a window that has room for the desktop box (a centred card) from a phone (the whole screen). */
function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia("(min-width: 640px)").matches);
  useEffect(() => {
    const list = matchMedia("(min-width: 640px)");
    const on = () => setWide(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return wide;
}

interface Found {
  answer: SearchResponse | null;
  ms: number;
  error: boolean;
}

/** useAnswer asks the server for each text, newest text last: an answer that is not for the text now typed is dropped. */
function useAnswer(q: string): Found {
  const [found, setFound] = useState<Found>({ answer: null, ms: 0, error: false });
  useEffect(() => {
    if (q.trim() === "") {
      setFound({ answer: null, ms: 0, error: false });
      return;
    }
    const abort = new AbortController();
    const began = performance.now();
    call(client.GET("/api/search", { params: { query: { q, limit: ASKED } }, signal: abort.signal }))
      .then((answer) => setFound({ answer, ms: performance.now() - began, error: false }))
      .catch((err) => {
        if (!abort.signal.aborted && !(err && err.handled)) setFound((f) => ({ ...f, error: true }));
      });
    return () => abort.abort();
  }, [q]);
  return found;
}
