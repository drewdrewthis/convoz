// The side panel: Convoz itself (the web app in a frame, with the browser's own sign-in) and a bar that shares the tab the owner is
// on with the conversation open in the frame, with the owner's words about it (page-share.feature). It sets the server once and reads nothing until the owner shares.
import { Convoz } from "./api.ts";
import { ApiFailure, describe } from "./errors.ts";
import { maskUrl } from "./page.ts";
import { chatsUrl, serverOrigin } from "./server.ts";
import { checkShared, endedText, runShare, webOrigin, type Ended, type SharedTab } from "./share.ts";

const app = document.getElementById("app")!;
const bar = document.getElementById("controls")!;

type Kid = Node | string;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}
const statusLine = (text = "") => h("p", { className: "status", role: "status", textContent: text });
const changeServer = (server: string) => h("button", { type: "button", className: "quiet", textContent: "Change server", onclick: () => setup(server) });
// the signed-out view's wait for the owner to come back; a newer view (setup, load) cancels it, so it cannot undo that view
let waitForSignIn: AbortController | undefined;

// The worker ends this panel's share when the panel closes (background.ts). A worker that was stopped and started again has lost
// the port: the panel connects again and says its share once more.
let port = connect();
let said: unknown = null;
function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: "panel" });
  p.onDisconnect.addListener(() => {
    port = connect();
    port.postMessage(said);
  });
  return p;
}
function tellWorker(message: { server: string; share: string; tabId: number } | null): void {
  said = message;
  port.postMessage(message);
}

async function start(): Promise<void> {
  const { server } = await chrome.storage.local.get("server");
  if (typeof server !== "string") return setup("");
  if (!(await chrome.permissions.contains({ origins: [server + "/*"] }))) return setup(server, `Convoz needs access to ${server} again.`);
  await load(server);
}

function setup(value: string, message = ""): void {
  waitForSignIn?.abort();
  bar.replaceChildren();
  const input = h("input", { id: "server", type: "url", value, placeholder: "https://convoz.example.ts.net", required: true });
  const status = statusLine(message);
  const form = h("form", {}, h("label", { htmlFor: "server", textContent: "Convoz server" }), input, h("button", { type: "submit", textContent: "Save" }), status);
  form.onsubmit = (e) => {
    e.preventDefault();
    const origin = serverOrigin(input.value);
    if (!origin) {
      status.textContent = "Type the https address of your Convoz server.";
      return;
    }
    // asked before any other await: Chrome shows its prompt only while the click still counts as the owner's gesture
    void chrome.permissions
      .request({ origins: [origin + "/*"] })
      .then(async (granted) => {
        if (!granted) {
          status.textContent = `Convoz needs access to ${origin}.`;
          return;
        }
        await chrome.storage.local.set({ server: origin });
        await load(origin);
      })
      .catch((err: unknown) => {
        status.textContent = describe(err, origin, "Saving");
      });
  };
  app.replaceChildren(h("div", { className: "pad" }, form));
}

async function load(server: string): Promise<void> {
  waitForSignIn?.abort();
  const api = new Convoz(server);
  bar.replaceChildren();
  app.replaceChildren(h("div", { className: "pad" }, statusLine("Loading…")));
  try {
    await api.me();
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut(api);
    app.replaceChildren(
      h("div", { className: "pad" }, statusLine(describe(err, server, "Loading")), h("button", { type: "button", textContent: "Try again", onclick: () => void load(server) }), changeServer(server)),
    );
    return;
  }
  await chat(api);
}

function signedOut(api: Convoz): void {
  // the owner signs in on a tab and comes back: the panel loads again when it gets the focus
  waitForSignIn = new AbortController();
  window.addEventListener("focus", () => void load(api.server), { once: true, signal: waitForSignIn.signal });
  app.replaceChildren(
    h(
      "div",
      { className: "pad" },
      h("p", { textContent: "This browser is not signed in to Convoz." }),
      h("button", { type: "button", textContent: "Sign in to Convoz", onclick: () => void chrome.tabs.create({ url: api.server + "/signin" }) }),
      changeServer(api.server),
    ),
  );
}

// the read hides field values; a screenshot cannot, so the owner hears it once per share, next to the status
const SHOT_WARNING = "A screenshot shows what is on screen, including text the read hides.";
const OPEN_A_CONVERSATION = "Open a conversation, then click Share this tab under its title.";
const GO_TO_THE_TAB = "Go to the tab you want to share, then click Share.";
/** The badge on the Convoz button of the shared tab while the share lives. */
const BADGE = "ON";
const badge = (tabId: number, text: string) => void chrome.action.setBadgeText({ tabId, text }).catch(() => {});

type Open = { id: number; title: string };

/**
 * chat shows the web app, opened on the conversation the owner used last, and the share bar. "Share this tab" is in the open
 * conversation's header (the web app asks the panel with convoz:share); the bar then asks "What should they look at?", and Send shares
 * the tab and posts those words in the conversation, so the agents get it in their inbox.
 */
async function chat(api: Convoz): Promise<void> {
  const { lastConversation } = await chrome.storage.local.get("lastConversation");
  const frame = h("iframe", { title: "Convoz", src: chatsUrl(api.server, lastConversation) });
  const status = statusLine();
  let open: Open | null = null;
  let busy = false; // composing or sharing: the bar is taken

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown; title?: unknown } | null;
    if (event.source !== frame.contentWindow || event.origin !== api.server) return;
    if (data?.type === "convoz:conversation") {
      open = typeof data.id === "number" ? { id: data.id, title: typeof data.title === "string" ? data.title : "" } : null;
      if (open) void chrome.storage.local.set({ lastConversation: open.id });
      if (!busy) idle();
    } else if (data?.type === "convoz:share" && open && data.id === open.id) {
      if (busy) status.textContent = "Stop the share that is on first.";
      else void compose(open);
    }
  });

  const idle = (message = "") => {
    busy = false;
    tellWorker(null);
    status.textContent = message || (open ? "" : OPEN_A_CONVERSATION);
    bar.replaceChildren(status);
  };

  // The tab is the one in front when the owner clicks Share; the owner says what to look at, and Send shares it.
  const compose = async (conversation: Open) => {
    busy = true;
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      const [tab] = win.id === undefined ? [] : await chrome.tabs.query({ active: true, windowId: win.id });
      const origin = webOrigin(tab?.url);
      if (tab?.id === undefined || !origin) return idle(GO_TO_THE_TAB);
      const ask = h("textarea", { id: "ask", rows: 3, placeholder: "The error after Pay now" });
      const send = h("button", { type: "submit", textContent: "Send" });
      const cancel = h("button", { type: "button", className: "quiet", textContent: "Cancel", onclick: () => idle() });
      const form = h(
        "form",
        { className: "ask" },
        h("p", { className: "note", textContent: `Share ${tab.title || new URL(origin).host} with ${conversation.title || "this conversation"}` }),
        h("label", { htmlFor: "ask", textContent: "What should they look at?" }),
        ask,
        h("span", { className: "row" }, send, cancel),
      );
      // Enter sends, Shift+Enter is a new line, as in the chat
      ask.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        send.disabled = true;
        // asked before any other await: Chrome shows its prompt only while the click still counts as the owner's gesture
        void chrome.permissions
          .request({ origins: [origin + "/*"] })
          .then((granted) => (granted ? share(conversation, tab.id!, origin, ask.value) : idle(`Convoz needs access to ${origin} to share it.`)))
          .catch((err: unknown) => idle(describe(err, api.server, "Sharing")));
      };
      status.textContent = "";
      bar.replaceChildren(form, status);
      ask.focus();
    } catch (err) {
      idle(describe(err, api.server, "Sharing"));
    }
  };

  const share = async (conversation: Open, tabId: number, origin: string, words: string) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || webOrigin(tab.url) !== origin) return idle(`The tab was closed or left its site. ${GO_TO_THE_TAB}`);
    const host = new URL(origin).host;
    const made = await api.startShare(conversation.id, origin, { ask: words.trim(), tab_title: tab.title ?? "", tab_url: maskUrl(tab.url ?? origin) });
    const { title, handles } = await api.conversation(conversation.id);
    const shared: SharedTab = { id: made.id, tabId, origin };
    const stop = new AbortController();
    let reason: Ended = "stopped";
    const end = (why: Ended) => {
      if (stop.signal.aborted) return;
      reason = why;
      stop.abort();
      void api.stopShare(made.id, why === "stopped" ? "stopped" : "left").catch(() => {});
    };
    const stopButton = h("button", { type: "button", textContent: "Stop", onclick: () => end("stopped") });
    // the tab closing or going to another site ends the share at once, before any agent asks; other tabs in front do not
    const check = () => void checkShared(shared).then((now) => "ended" in now && end(now.ended));
    const onRemoved = (id: number) => id === tabId && check();
    const onUpdated = (id: number) => id === tabId && check();
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);
    status.textContent = `Shared with ${title || conversation.title || "this conversation"} · ${handles.map((x) => "@" + x).join(" ")}`;
    bar.replaceChildren(stopButton, status, h("p", { className: "note", textContent: SHOT_WARNING }));
    badge(tabId, BADGE);
    const ended = await runShare(api, shared, stop.signal, () => tellWorker({ server: api.server, share: made.id, tabId }));
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    badge(tabId, "");
    idle(endedText(ended === "stopped" ? reason : ended, host));
  };

  idle();
  app.replaceChildren(frame);
}

void start();
