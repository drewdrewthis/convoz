"use strict";
// Chat pages: the Chats list, New chat and a conversation. Loaded after console.js, whose $, el, api and ApiError it uses.
// Text goes in with textContent only. Agent markdown is parsed by renderMarkdown into elements we build ourselves,
// so no message can bring markup, an image, or a script URL (CSP forbids inline script as well).

(() => {
  const PAGE = document.body.dataset.page;

  // ---- small helpers ----------------------------------------------------------------------------------

  /** newId makes a client id (8 to 64 characters). getRandomValues also works where randomUUID does not (plain http). */
  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** whenLabel is the short time in a list row: the clock today, then Yesterday, the weekday, the date. */
  function whenLabel(ms) {
    const at = new Date(ms);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
    if (days <= 0) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (days === 1) return "Yesterday";
    if (days < 7) return at.toLocaleDateString(undefined, { weekday: "short" });
    return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /** onResume runs fn when the app comes back: bfcache restore, tab visible again, network back. */
  function onResume(fn) {
    addEventListener("pageshow", fn);
    addEventListener("online", fn);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") fn();
    });
  }

  /** coalesce makes fn run one at a time: calls that arrive while it runs become one more run. */
  function coalesce(fn) {
    let running = false;
    let again = false;
    return async function run() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } catch {
        /* the next resume or frame tries again */
      } finally {
        running = false;
      }
    };
  }

  /**
   * openStream keeps one EventSource('/api/stream'). The browser reconnects on its own with Last-Event-ID; onResync runs
   * when it is open again after an error, and ensure() reopens a stream the phone closed without telling us.
   */
  function openStream(names, onFrame, onResync) {
    let es = null;
    let failed = false;
    let timer = 0;
    const connect = () => {
      clearTimeout(timer);
      const mine = new EventSource("/api/stream");
      es = mine;
      mine.addEventListener("open", () => {
        if (failed) {
          failed = false;
          onResync();
        }
      });
      mine.addEventListener("error", () => {
        failed = true;
        if (mine.readyState === 2) timer = setTimeout(connect, 3000); // refused (not a dropped link): try later
      });
      for (const name of names) {
        mine.addEventListener(name, (event) => {
          let data = null;
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          onFrame(name, data);
        });
      }
    };
    connect();
    return {
      ensure() {
        if (!es || es.readyState === 2) connect();
      },
    };
  }

  /** initials is the avatar text: the first two letters of a handle, so @devtool and @docs differ. */
  function initials(handle) {
    return (handle || "?").slice(0, 2);
  }

  /** stripCf drops format characters (bidi controls, zero-width) so text cannot reorder or hide what the owner reads.
   *  The server strips them from previews and rejects them in display names; titles and bodies are stored as sent, so they are stripped here.
   *  Display names are stripped too, as a guard for rows saved before ValidDisplayName rejected Cf. */
  const stripCf = (text) => String(text).replace(/\p{Cf}/gu, "");

  // ---- Chats ------------------------------------------------------------------------------------------

  function chatRow(c, mine) {
    const agent = c.participants.find((p) => p.kind === "agent");
    const unread = c.unread > 0;
    const preview = c.last ? `${c.last.author_handle === mine ? "You" : `@${c.last.author_handle}`}: ${c.last.preview}` : "No messages yet";
    const flag = unread ? el("span", { class: "flag" }, el("span", { class: "dot", role: "img", "aria-label": "Unread" }), el("span", { class: "count" }, c.unread > 99 ? "99+" : String(c.unread))) : null;
    return el(
      "li",
      { class: unread ? "unread" : null },
      el(
        "a",
        { class: "chatrow", href: `/chats/${c.id}` },
        el("div", { class: "ava", "aria-hidden": "true" }, initials(agent && agent.handle)),
        el(
          "div",
          { class: "rowbody" },
          el("div", { class: "rowtop" }, el("h2", { class: "rowtitle" }, stripCf(c.title) || "New chat"), el("time", { class: "when" }, whenLabel(c.last_activity_at))),
          el("div", { class: "rowbot" }, el("span", { class: "preview" }, preview), flag),
        ),
      ),
    );
  }

  async function chatsPage() {
    const me = (await api("GET", "/api/me")).identity.handle;
    const list = $("#chat-list");
    const empty = $("#chats-empty");
    const rows = new Map(); // id -> { sig, node }: a row that did not change keeps its node
    const load = coalesce(async () => {
      const { conversations } = await api("GET", "/api/conversations");
      const next = new Map();
      for (const c of conversations) {
        const sig = JSON.stringify([c.title, c.last, c.unread, c.last_activity_at, c.participants]);
        const old = rows.get(c.id);
        next.set(c.id, old && old.sig === sig ? old : { sig, node: chatRow(c, me) });
      }
      rows.clear();
      next.forEach((v, k) => rows.set(k, v));
      [...next.values()].forEach((v, i) => {
        if (list.children[i] !== v.node) list.insertBefore(v.node, list.children[i] || null);
      });
      while (list.children.length > next.size) list.lastElementChild.remove();
      list.hidden = conversations.length === 0;
      empty.hidden = conversations.length !== 0;
      $("#chats").removeAttribute("aria-busy");
    });
    let timer = 0;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 80);
    };
    const stream = openStream(["message.created", "read.moved", "conversation.created"], soon, load);
    onResume(() => {
      stream.ensure();
      load();
    });
    await load();
  }

  // ---- safe markdown ----------------------------------------------------------------------------------

  // Every quantifier is bounded. The label class excludes "[" and the URL class excludes "(", "[" and whitespace, so a scan
  // started at one "[" ends at the next one: O(1) work per start, linear overall.
  const INLINE = /`([^`\n]{1,500})`|\[([^[\]\n]{1,200})\]\(([^()[\]\s]{1,2048})\)|\*\*([^*\n]{1,500}?)\*\*|(https?:\/\/[^\s<>]{1,2048})/g;

  /** safeUrl returns u when it is an absolute http, https or mailto URL, else null. */
  function safeUrl(u) {
    try {
      return ["http:", "https:", "mailto:"].includes(new URL(u).protocol) ? u : null;
    } catch {
      return null;
    }
  }

  const link = (href, label) => el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

  // A host-like or email-like token inside a label: "paypal.com", "https://x.test/a", "me@x.test".
  const NAMED = /(?:[\p{L}\p{N}._%+-]{1,64}@)?(?:https?:\/\/)?(?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24}(?::\d{1,5})?/giu;
  // A label that is only an IPv4 address, "localhost" or a dotless host ("intranet"), with an optional scheme and port.
  const PLAIN_HOST = /^(?:https?:\/\/)?(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|[\p{L}\p{N}-]{1,63})(?::\d{1,5})?$/iu;
  const bare = (host) => host.toLowerCase().replace(/^www\./, "");

  /** honestLabel stops a link from naming one site and opening another: when the label holds any host or email that is
   *  not the href's host, the real host is appended. The label is checked after NFKC and with ideographic dots read as dots,
   *  so full-width and no-break-space tricks do not hide a name. Combining marks (even invisible ones such as U+034F) are
   *  removed from the copy that is checked; the original is what is shown. */
  function honestLabel(label, href) {
    const shown = label.trim();
    const target = new URL(href);
    const mail = target.protocol === "mailto:";
    const real = mail ? target.pathname : target.host;
    const seen = shown.normalize("NFKC").replace(/[\u3002\uff61]/g, ".").replace(/\p{M}/gu, "");
    const plain = seen.trim();
    if (!mail && PLAIN_HOST.test(plain) && bare(plain.replace(/^https?:\/\//i, "")) !== bare(real)) return `${shown} (${real})`;
    for (const token of seen.match(NAMED) || []) {
      let named = token.replace(/^https?:\/\//i, "");
      if (token.includes("@")) named = mail ? token : token.split("@").pop();
      if (bare(named) !== bare(real)) return `${shown} (${real})`;
    }
    return shown;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) {
        parent.append(el("code", null, m[1]));
      } else if (m[2] != null) {
        const href = safeUrl(m[3]);
        parent.append(href ? link(href, honestLabel(m[2], href)) : m[0]);
      } else if (m[4] != null) {
        parent.append(el("strong", null, m[4]));
      } else {
        const url = m[5].replace(/[.,;:!?)\]]+$/, "");
        const href = safeUrl(url);
        parent.append(href ? link(href, url) : url, m[5].slice(url.length));
      }
    }
    parent.append(text.slice(last));
  }

  /** renderMarkdown builds paragraphs, fenced code, inline code, bold and links. Anything else stays literal text. */
  function renderMarkdown(source) {
    const root = el("div", { class: "text" });
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      inline(p, para.join("\n"));
      root.append(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}```/.test(lines[i])) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^\s{0,3}```/.test(lines[i]); i++) code.push(lines[i]);
        root.append(el("pre", null, el("code", null, code.join("\n"))));
      } else if (lines[i].trim() === "") {
        flush();
      } else {
        para.push(lines[i]);
      }
    }
    flush();
    return root;
  }

  // ---- a conversation (and New chat) ------------------------------------------------------------------
  //
  // chatPage builds one `chat` object and hands it to the parts below. Each part owns its own state and DOM, and reaches
  // the others only through chat.<part> when it runs, so the order the parts are built in does not matter.
  //   header     title, agent line, "is working" note
  //   transcript the messages, the pending sends, the scroll position
  //   cursor     the read position, sent only while the chat is in view
  //   live       the event stream and the catch-up after a gap
  //   composer   the text box and sending

  const LIMIT = 100;
  const NEAR_BOTTOM = 80;

  function header(chat) {
    const heading = $("#heading");
    const subtitle = $("#subtitle");
    const note = $("#working");
    let titled = false;
    let working = false;
    let workTimer = 0;

    function setTitle(title) {
      heading.textContent = stripCf(title) || "New chat";
      document.title = `${heading.textContent} - Convoz`;
      titled = Boolean(title);
    }

    function paintSubtitle() {
      const agent = chat.agent;
      if (!agent) return;
      const state = working ? ["Working…", "busy"] : agent.online ? ["Online", "on"] : ["Offline", ""];
      subtitle.replaceChildren(el("span", { class: "who" }, `@${agent.handle}`), el("span", { class: `presence ${state[1]}`.trim() }, state[0]));
      subtitle.hidden = false;
    }

    function setWorking(on, until) {
      clearTimeout(workTimer);
      working = on;
      note.hidden = !on;
      if (on) {
        note.textContent = `@${chat.agent.handle} is working…`;
        workTimer = setTimeout(() => setWorking(false), Math.max(0, (until || Date.now() + 300_000) - Date.now()));
        chat.transcript.followIfStuck();
      }
      paintSubtitle();
    }

    async function refresh() {
      const { conversation } = await api("GET", `/api/conversations/${chat.convId}`);
      setTitle(conversation.title);
    }

    /** gone replaces the page with an error box. */
    function gone(message, title = "Chat not found") {
      heading.textContent = title;
      document.title = `${title} - Convoz`;
      $("#picker").hidden = true;
      $("#convo").hidden = true;
      const box = $("#chat-error");
      box.textContent = message;
      box.hidden = false;
    }

    return { setTitle, paintSubtitle, setWorking, refresh, gone, hasTitle: () => titled };
  }

  function transcript(chat) {
    const log = $("#log");
    const items = $("#items");
    const pill = $("#pill");
    const msgs = new Map(); // id -> message
    const pending = []; // owner messages not yet confirmed: { cid, body, state: "sending" | "failed", base }
    const shown = new Map(); // key -> { el, sig }
    let stuck = true; // the log shows its newest end
    let hasEarlier = false;

    const isMine = (m) => m.author.handle === chat.me.handle;
    const maxId = () => Math.max(0, ...msgs.keys());
    const minId = () => Math.min(...msgs.keys());
    const fromBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight;
    const hidePill = () => (pill.hidden = true);
    function toBottom() {
      log.scrollTop = log.scrollHeight;
      stuck = true;
      hidePill();
    }

    function messageNode(m, first) {
      const mine = isMine(m);
      const text = stripCf(m.body);
      const body = !mine && m.format === "markdown" ? renderMarkdown(text) : el("div", { class: "text" }, text);
      return el("article", { class: `msg ${mine ? "mine" : "theirs"}${first ? " first" : ""}` }, !mine && first ? el("div", { class: "byline" }, `@${m.author.handle}`) : null, " ", body);
    }

    function pendingNode(p) {
      const bad = p.state === "failed";
      const state = bad
        ? el("div", { class: "sendstate bad" }, "Not sent", el("button", { class: "retry", type: "button", onclick: () => chat.composer.deliver(p) }, "Retry"))
        : el("div", { class: "sendstate" }, "Sending…");
      return el("article", { class: "msg mine" }, el("div", { class: "text" }, stripCf(p.body)), state);
    }

    /** render makes the list match msgs and pending, reusing the nodes that did not change so a selection survives. */
    function render({ keepTop = false } = {}) {
      const follow = stuck && !keepTop;
      const want = [];
      let prev = null;
      for (const m of [...msgs.values()].sort((a, b) => a.id - b.id)) {
        const first = isMine(m) ? false : !prev || prev !== m.author.handle;
        want.push({ key: `m${m.id}`, sig: String(first), make: () => messageNode(m, first) });
        prev = isMine(m) ? null : m.author.handle;
      }
      for (const p of pending) want.push({ key: `p${p.cid}`, sig: p.state, make: () => pendingNode(p) });

      const keep = new Set(want.map((w) => w.key));
      for (const [key, v] of shown) {
        if (!keep.has(key)) {
          v.el.remove();
          shown.delete(key);
        }
      }
      want.forEach((w, i) => {
        let v = shown.get(w.key);
        if (!v || v.sig !== w.sig) {
          const node = w.make();
          if (v) v.el.replaceWith(node);
          v = { el: node, sig: w.sig };
          shown.set(w.key, v);
        }
        if (items.children[i] !== v.el) items.insertBefore(v.el, items.children[i] || null);
      });
      $("#earlier").hidden = !hasEarlier;
      if (follow) toBottom();
    }

    /** dropPending forgets the pending copy of an owner message that came back from the server (another route than the POST reply). */
    function dropPending(m) {
      const at = pending.findIndex((p) => p.body === m.body && m.id > p.base);
      if (at >= 0) pending.splice(at, 1);
    }

    /** incoming merges server messages by id. Nothing shows twice, and a reply while the owner reads older text shows the pill. */
    function incoming(list) {
      const added = list.filter((m) => !msgs.has(m.id));
      if (!added.length) return;
      for (const m of added) {
        msgs.set(m.id, m);
        if (isMine(m)) dropPending(m);
        else if (chat.agent && m.author.handle === chat.agent.handle) chat.header.setWorking(false);
      }
      const wasStuck = stuck;
      render();
      if (!wasStuck && added.some((m) => !isMine(m))) pill.hidden = false;
      chat.cursor.markRead();
    }

    /** load shows the first page of an opened conversation. */
    function load(messages) {
      hasEarlier = messages.length >= LIMIT;
      for (const m of messages) msgs.set(m.id, m);
      render();
      toBottom();
      requestAnimationFrame(() => stuck && toBottom());
    }

    /** send puts an owner message in the list as pending and keeps the newest end in view. */
    function addPending(body, cid) {
      const p = { cid, body, state: "sending", base: maxId() };
      pending.push(p);
      stuck = true;
      return p;
    }

    /** confirm swaps a pending message for the one the server stored. */
    function confirm(p, sent) {
      const at = pending.indexOf(p);
      if (at >= 0) pending.splice(at, 1);
      if (!msgs.has(sent.id)) msgs.set(sent.id, { id: sent.id, author: chat.me, body: p.body, format: "plain", created_at: sent.created_at });
    }

    log.addEventListener(
      "scroll",
      () => {
        const gap = fromBottom();
        stuck = gap <= NEAR_BOTTOM;
        if (gap <= 8) hidePill();
      },
      { passive: true },
    );
    new ResizeObserver(() => {
      if (stuck) log.scrollTop = log.scrollHeight;
    }).observe(log);
    pill.addEventListener("click", toBottom);

    $("#earlier-button").addEventListener("click", async () => {
      const before = minId();
      const { messages } = await api("GET", `/api/conversations/${chat.convId}/messages?before=${before}&limit=${LIMIT}`);
      hasEarlier = messages.length >= LIMIT;
      const height = log.scrollHeight;
      const top = log.scrollTop;
      for (const m of messages) msgs.set(m.id, m);
      render({ keepTop: true });
      log.scrollTop = top + (log.scrollHeight - height);
    });

    return { render, incoming, load, addPending, confirm, maxId, toBottom, followIfStuck: () => stuck && toBottom() };
  }

  function readCursor(chat) {
    let readOk = 0; // the newest id the server confirmed as read
    const postRead = (top, keepalive) =>
      fetch(`/api/conversations/${chat.convId}/read`, {
        method: "POST",
        credentials: "same-origin",
        keepalive,
        headers: { "Content-Type": "application/json", "X-Convoz": "1" },
        body: JSON.stringify({ main_id: top }),
      });
    const markRead = coalesce(async () => {
      const top = chat.transcript.maxId();
      if (!chat.convId || document.visibilityState !== "visible" || top <= readOk) return;
      const res = await postRead(top, false).catch(() => null);
      if (res) await res.text().catch(() => ""); // read the answer so the connection is released
      if (res && res.ok) readOk = Math.max(readOk, top);
    });
    // Leaving right after opening must not lose the cursor: a keepalive request outlives the page. (Only here, because
    // browser test tools never see a keepalive request finish.)
    addEventListener("pagehide", () => {
      const top = chat.transcript.maxId();
      if (chat.convId && top > readOk) postRead(top, true).catch(() => {});
    });
    return { markRead };
  }

  function live(chat) {
    /** catchUp fetches everything after the newest id we hold. */
    const catchUp = coalesce(async () => {
      if (!chat.convId) return;
      for (;;) {
        const after = chat.transcript.maxId();
        const { messages } = await api("GET", `/api/conversations/${chat.convId}/messages?${after ? `after=${after}&` : ""}limit=${LIMIT}`);
        chat.transcript.incoming(messages);
        if (messages.length < LIMIT) break;
      }
      if (!chat.header.hasTitle()) await chat.header.refresh();
    });

    async function refreshCrew() {
      const row = (await identities()).find((p) => chat.agent && p.handle === chat.agent.handle);
      if (row) {
        chat.agent.online = Boolean(row.online);
        chat.header.paintSubtitle();
      }
    }

    const stream = openStream(
      ["message.created", "agent.working"],
      (name, data) => {
        if (data.conversation_id !== chat.convId) return;
        if (name === "message.created") chat.transcript.incoming([data]);
        else if (chat.agent && data.handle === chat.agent.handle) chat.header.setWorking(Boolean(data.working), data.until);
      },
      catchUp,
    );
    onResume(() => {
      stream.ensure();
      catchUp();
      chat.cursor.markRead();
      refreshCrew().catch(() => {});
    });
  }

  function composer(chat) {
    const form = $("#composer");
    const text = $("#text");
    const send = $("#send");
    const phone = matchMedia("(pointer: coarse), (max-width: 600px)");
    const convCid = newId(); // the id of the conversation this page may create; a retry reuses it
    let creating = null;

    function autosize() {
      text.style.height = "auto";
      text.style.height = `${Math.min(text.scrollHeight + 2, 180)}px`; // +2: the border, which scrollHeight leaves out
      send.disabled = text.value.trim() === "";
    }

    function ensureConversation() {
      if (chat.convId) return Promise.resolve();
      creating ||= api("POST", "/api/conversations", { client_id: convCid, participants: [chat.agent.handle] })
        .then(({ conversation }) => {
          chat.convId = conversation.id;
          history.replaceState(null, "", `/chats/${chat.convId}`);
        })
        .finally(() => {
          creating = null;
        });
      return creating;
    }

    async function deliver(p) {
      p.state = "sending";
      chat.transcript.render();
      try {
        await ensureConversation();
        const sent = await api("POST", `/api/conversations/${chat.convId}/messages`, { client_id: p.cid, body: p.body });
        chat.transcript.confirm(p, sent);
        chat.transcript.render();
        chat.cursor.markRead();
        if (!chat.header.hasTitle()) chat.header.refresh().catch(() => {});
      } catch (err) {
        if (err && err.handled) return;
        p.state = "failed";
        chat.transcript.render();
      }
    }

    /** paintLabel names the message box and its placeholder: "Message @agent", or "Message" when several agents are in the chat. */
    function paintLabel(agents) {
      const label = agents > 1 ? "Message" : `Message @${chat.agent.handle}`;
      text.setAttribute("aria-label", label);
      text.setAttribute("placeholder", label);
    }

    text.addEventListener("input", autosize);
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !phone.matches) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = text.value.trim();
      if (!body) return;
      text.value = "";
      autosize();
      text.focus(); // the keyboard stays up
      deliver(chat.transcript.addPending(body, newId()));
    });

    return { deliver, paintLabel, focus: () => text.focus() };
  }

  /** fitFrame makes the frame follow the visible screen (iOS keeps the layout viewport under the keyboard). */
  function fitFrame() {
    const frame = $("#frame");
    function fit() {
      const vv = window.visualViewport;
      if (!vv) return;
      frame.style.setProperty("--vv-h", `${vv.height}px`);
      frame.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      document.body.classList.toggle("kbd", vv.height < innerHeight - 80);
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", fit);
      window.visualViewport.addEventListener("scroll", fit);
    }
    addEventListener("resize", fit);
    fit();
    return fit;
  }

  /** identities lists everyone the owner can chat with. */
  async function identities() {
    return (await api("GET", "/api/identities")).identities;
  }

  const agentOf = (p) => ({ handle: p.handle, display_name: p.display_name, online: Boolean(p.online) });

  /** pickAgent fills the New chat picker; choosing an agent (or ?with=) opens the composer through open(agent). */
  function pickAgent(crew, open) {
    const list = $("#agents");
    for (const who of crew) {
      const choose = () => {
        history.replaceState(null, "", `/chats/new?with=${encodeURIComponent(who.handle)}`);
        open(agentOf(who));
      };
      list.append(
        el(
          "li",
          null,
          el(
            "button",
            { class: "agentbtn", type: "button", onclick: choose },
            el("span", { class: "ava", "aria-hidden": "true" }, initials(who.handle)),
            el("span", { class: "who" }, el("span", { class: "handle" }, `@${who.handle}`), " ", el("span", { class: "name" }, stripCf(who.display_name))),
            " ",
            el("span", { class: `state${who.online ? " on" : ""}` }, who.online ? "Online" : "Offline"),
          ),
        ),
      );
    }
    if (!crew.length) {
      const noteBox = $("#picker-note");
      noteBox.textContent = "No agents yet. Connect a machine and add an agent first.";
      noteBox.hidden = false;
    }
    $("#picker").hidden = false;
    const wanted = crew.find((p) => p.handle === new URLSearchParams(location.search).get("with"));
    if (wanted) open(agentOf(wanted));
  }

  async function chatPage() {
    const isNew = location.pathname === "/chats/new";
    const idPart = location.pathname.split("/")[2];
    const chat = { convId: isNew ? 0 : Number(idPart), agent: null, me: null };
    chat.header = header(chat);

    $("#back").addEventListener("click", (event) => {
      const sameSite = document.referrer.startsWith(location.origin + "/");
      if (history.length > 1 && sameSite) {
        event.preventDefault();
        history.back();
      }
    });

    const [meRes, people] = await Promise.all([api("GET", "/api/me"), identities()]);
    chat.me = { handle: meRes.identity.handle, display_name: meRes.identity.display_name, kind: "human" };
    const crew = people.filter((p) => p.kind === "agent" && !p.disabled);
    chat.transcript = transcript(chat);
    chat.cursor = readCursor(chat);
    chat.composer = composer(chat);
    live(chat);
    const fit = fitFrame();

    function openComposer(who, agents = 1) {
      chat.agent = who;
      chat.composer.paintLabel(agents);
      chat.header.paintSubtitle();
      $("#picker").hidden = true;
      $("#convo").hidden = false;
      fit();
      chat.composer.focus();
    }

    if (isNew) {
      chat.header.setTitle("");
      pickAgent(crew, openComposer);
      return;
    }

    let conversation;
    try {
      ({ conversation } = await api("GET", `/api/conversations/${chat.convId}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return chat.header.gone("This chat does not exist, or it is not yours.");
      throw err;
    }
    chat.header.setTitle(conversation.title);
    const who = conversation.participants.find((p) => p.kind === "agent") || { handle: "agent", display_name: "Agent" };
    const known = crew.find((p) => p.handle === who.handle);
    $("#convo").hidden = false;
    chat.agent = { handle: who.handle, display_name: who.display_name, online: Boolean(known && known.online) };
    chat.composer.paintLabel(conversation.participants.filter((p) => p.kind === "agent").length);
    chat.header.paintSubtitle();
    fit();
    const { messages } = await api("GET", `/api/conversations/${chat.convId}/messages?limit=${LIMIT}`);
    chat.transcript.load(messages);
    chat.cursor.markRead();
  }

  const start = { chats: chatsPage, chat: chatPage }[PAGE];
  if (start) {
    Promise.resolve(start()).catch((err) => {
      if (err && err.handled) return;
      const box = $("#chat-error") || $("#status");
      box.textContent = (err && err.message) || "Something went wrong. Try again.";
      box.hidden = false;
      if (box.id === "status") box.className = "banner error";
    });
  }
})();
