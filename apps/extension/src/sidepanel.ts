// The side panel: Convoz itself (the web app in a frame, with the browser's own sign-in) and a bar that shares the tab the owner is
// on with the conversation open in the frame (page-share.feature). It sets the server once and reads nothing until the owner shares.
import { Convoz } from "./api.ts";
import { ApiFailure, describe } from "./errors.ts";
import { serverOrigin } from "./server.ts";
import { runShare, webOrigin, type Ended, type SharedTab } from "./share.ts";

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
function tellWorker(message: { server: string; share: string } | null): void {
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
  chat(api);
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

const ENDED: Record<Ended, string> = {
  stopped: "Sharing stopped.",
  left: "Sharing ended: the tab was closed, left its site or is not in front.",
  gone: "Sharing ended.",
};

/** chat shows the web app and the share bar. The frame says which conversation is open; only that one can be shared with. */
function chat(api: Convoz): void {
  const frame = h("iframe", { title: "Convoz", src: `${api.server}/chats` });
  const status = statusLine();
  const shareButton = h("button", { type: "button", textContent: "Share this tab", disabled: true });
  let open: { id: number; title: string } | null = null;
  let sharing: { stop(): void } | null = null;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown; title?: unknown } | null;
    if (event.source !== frame.contentWindow || event.origin !== api.server || data?.type !== "convoz:conversation") return;
    open = typeof data.id === "number" ? { id: data.id, title: typeof data.title === "string" ? data.title : "" } : null;
    shareButton.disabled = !open;
  });

  const idle = (message = "") => {
    sharing = null;
    tellWorker(null);
    shareButton.disabled = !open;
    status.textContent = message;
    bar.replaceChildren(shareButton, status);
  };

  shareButton.onclick = async () => {
    const conversation = open;
    if (!conversation || sharing) return;
    shareButton.disabled = true;
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      const [tab] = win.id === undefined ? [] : await chrome.tabs.query({ active: true, windowId: win.id });
      const origin = webOrigin(tab?.url);
      if (tab?.id === undefined || !origin) return idle("Click the Convoz button on the web page you want to share, then Share.");
      if (!(await chrome.permissions.request({ origins: [origin + "/*"] }))) return idle(`Convoz needs access to ${origin} to share it.`);
      const share = await api.startShare(conversation.id, origin);
      const { title, handles } = await api.conversation(conversation.id);
      const shared: SharedTab = { id: share.id, tabId: tab.id, origin };
      const stop = new AbortController();
      sharing = { stop: () => stop.abort() };
      const stopButton = h("button", { type: "button", textContent: "Stop" });
      stopButton.onclick = () => {
        stop.abort();
        void api.stopShare(share.id).catch(() => {});
      };
      // the tab closing or going to another site ends the share at once, before any agent asks
      const onRemoved = (tabId: number) => tabId === shared.tabId && stopButton.click();
      const onUpdated = (tabId: number, change: { url?: string }) => tabId === shared.tabId && change.url && webOrigin(change.url) !== origin && stopButton.click();
      chrome.tabs.onRemoved.addListener(onRemoved);
      chrome.tabs.onUpdated.addListener(onUpdated);
      status.textContent = `Shared with ${title || conversation.title || "this conversation"} · ${handles.map((x) => "@" + x).join(" ")}`;
      bar.replaceChildren(stopButton, status);
      const ended = await runShare(api, shared, stop.signal, () => tellWorker({ server: api.server, share: share.id }));
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      idle(ENDED[ended]);
    } catch (err) {
      idle(describe(err, api.server, "Sharing"));
    }
  };

  idle();
  app.replaceChildren(frame);
}

void start();
