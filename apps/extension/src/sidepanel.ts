// The side panel: set the server once, then pick an agent, write a note and send the page. It reads the page only at Send.
import { Convoz } from "./api.ts";
import { ApiFailure, describe } from "./errors.ts";
import { activeAgents, type Identity } from "./identities.ts";
import { newAttempt, sendPage, type Attempt } from "./send.ts";
import { serverOrigin } from "./server.ts";
import { captureTab } from "./tab.ts";

const app = document.getElementById("app")!;

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

const openLink = (server: string, id: number) => h("a", { href: `${server}/chats/${id}`, target: "_blank", rel: "noopener", textContent: "Open the conversation" });

async function start(): Promise<void> {
  const { server } = await chrome.storage.local.get("server");
  if (typeof server !== "string") return setup("");
  if (!(await chrome.permissions.contains({ origins: [server + "/*"] }))) return setup(server, `Convoz needs access to ${server} again.`);
  await load(server);
}

function setup(value: string, message = ""): void {
  waitForSignIn?.abort();
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
          status.textContent = `Convoz needs access to ${origin} to send. Nothing was sent.`;
          return;
        }
        await chrome.storage.local.set({ server: origin });
        await load(origin);
      })
      .catch((err: unknown) => {
        status.textContent = describe(err, origin, "Saving");
      });
  };
  app.replaceChildren(form);
}

async function load(server: string): Promise<void> {
  waitForSignIn?.abort();
  const api = new Convoz(server);
  app.replaceChildren(statusLine("Loading…"));
  try {
    await api.me();
    compose(api, activeAgents(await api.identities()));
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut(api);
    app.replaceChildren(statusLine(describe(err, server, "Loading")), h("button", { type: "button", textContent: "Try again", onclick: () => void load(server) }), changeServer(server));
  }
}

function signedOut(api: Convoz): void {
  // the owner signs in on a tab and comes back: the panel loads again when it gets the focus
  waitForSignIn = new AbortController();
  window.addEventListener("focus", () => void load(api.server), { once: true, signal: waitForSignIn.signal });
  app.replaceChildren(
    h("p", { textContent: "This browser is not signed in to Convoz." }),
    h("button", { type: "button", textContent: "Sign in to Convoz", onclick: () => void chrome.tabs.create({ url: api.server + "/signin" }) }),
    changeServer(api.server),
  );
}

function compose(api: Convoz, agents: Identity[]): void {
  const agent = h("select", { id: "agent" }, ...agents.map((a) => h("option", { value: a.handle, textContent: "@" + a.handle })));
  const note = h("textarea", { id: "note", rows: 4, maxLength: 1000, placeholder: "What should the agent do with this page?" });
  const shot = h("input", { id: "shot", type: "checkbox" });
  const send = h("button", { type: "submit", textContent: "Send", disabled: !agents.length });
  const status = statusLine();
  const picker = agents.length ? [h("label", { htmlFor: "agent", textContent: "Agent" }), agent] : [h("p", { textContent: "No agents yet" })];
  const form = h("form", {}, ...picker, h("label", { htmlFor: "note", textContent: "Note" }), note, h("label", { className: "check" }, shot, "Attach screenshot"), send, status);

  // one send of this form, kept until it succeeds so a retry makes nothing twice; another agent, note or screenshot choice is a
  // new send
  let attempt: Attempt | undefined;
  for (const field of [agent, note, shot]) field.addEventListener("input", () => (attempt = undefined));

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (send.disabled) return; // a second click while a send runs does nothing
    send.disabled = true;
    status.replaceChildren("Sending…");
    const current = (attempt ??= newAttempt());
    try {
      const sent = await sendPage(api, { handle: agent.value, note: note.value, screenshot: shot.checked, capture: captureTab }, current);
      attempt = undefined;
      note.value = "";
      status.replaceChildren(["Sent.", ...sent.notes].join(" ") + " ", openLink(api.server, sent.conversation));
    } catch (err) {
      const said = describe(err, api.server);
      // no silent half-send: a conversation that exists is linked even when the page did not reach it
      const made = current.conversation;
      status.replaceChildren(...(made === undefined ? [said] : [`${said} The conversation was made, but the page is not in it: `, openLink(api.server, made)]));
    } finally {
      send.disabled = false;
    }
  };
  app.replaceChildren(form, changeServer(api.server));
}

void start();
