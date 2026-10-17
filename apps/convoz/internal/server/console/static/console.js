"use strict";
// Owner console. No framework. Text goes in with textContent only.
//
// The one rule that shapes this file: iOS Safari allows ONE WebAuthn ceremony per tap, and only while the tap is
// fresh. So every ceremony button works from a Ticket: the options are fetched BEFORE the tap, the button waits
// (disabled) until they are ready, and the click handler calls navigator.credentials.get/create before any await.
// A step-up that needs two ceremonies (add a passkey) is two taps.

const $ = (selector, root = document) => root.querySelector(selector);
const body = document.body;
const PAGE = body.dataset.page;
const PUBLIC = "public" in body.dataset;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

let nextId = 0;
const uid = (prefix) => `${prefix}-${++nextId}`;

// ---- messages: banners in the page, never alert() ----------------------------------------------------

/** say puts a note in the status banner under the heading. */
function say(text) {
  const box = $("#status");
  box.textContent = text;
  box.hidden = !text;
}

/** fail shows an error banner (role=alert) in `root`, replacing the one there. An empty message clears it. */
function fail(message, root = $("main")) {
  root.querySelectorAll('[role="alert"]').forEach((n) => n.remove());
  if (!message) return;
  const box = el("p", { role: "alert" }, message);
  const anchor = $(".sheet-actions", root);
  if (anchor) anchor.before(box);
  else $("#status").after(box);
  box.scrollIntoView({ block: "nearest" });
}

// ---- talking to the server ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** safeNext keeps a ?next= value only when it is a path on this site. */
function safeNext(raw) {
  return typeof raw === "string" && /^\/(?![/\\])[^\u0000-\u001f]*$/.test(raw) ? raw : "/";
}

let leaving = false;
function toSignin() {
  leaving = true;
  const here = location.pathname + location.search;
  location.assign(here === "/" ? "/signin" : `/signin?next=${encodeURIComponent(here)}`);
}

async function api(method, path, payload, headers) {
  const init = { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Convoz": "1", ...(headers || {}) } };
  if (method !== "GET") init.body = JSON.stringify(payload ?? {});
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 204 or no body */
  }
  if (!res.ok) {
    const err = new ApiError((data && data.error && data.error.message) || res.statusText, res.status, data && data.error && data.error.code);
    if (res.status === 401 && err.code === "unauthorized" && !PUBLIC) {
      toSignin(); // the session ended while the page was open: sign in, then come back here
      err.handled = true;
    }
    throw err;
  }
  return data;
}

const SHOWN_AS_SENT = new Set(["machine_name_taken", "invalid_request", "handle_taken", "code_mismatch", "last_passkey", "invalid_code", "rate_limited"]);

/** humanError turns anything that can go wrong into one plain sentence. */
function humanError(err) {
  if (err && err.handled) return "";
  const name = err && err.name;
  if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
  if (name === "AbortError") return "The passkey prompt was cancelled. Try again.";
  if (name === "InvalidStateError") return "This device already has a Convoz passkey. Use another device or a security key.";
  if (name === "NotSupportedError" || name === "SecurityError") return "This browser cannot use that passkey here.";
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ceremony_invalid": return "The passkey check timed out. Tap again.";
      case "step_up_invalid": return "That passkey check was used up or timed out. Tap again.";
      case "step_up_required": return "This needs a fresh passkey check. Tap again.";
      case "passkey_too_new":
        return "This passkey was added less than 24 hours ago. Actions like this need an older passkey, so try again later or sign in with an older one.";
      case "invalid_credential": return "That passkey did not work. Try again.";
      case "machine_cap": return "Ten machines are active. Revoke one before approving another.";
      case "bootstrap_used": return "This setup link was already used.";
      case "bootstrap_expired": return "This setup link expired.";
      case "bootstrap_invalid": return "This setup link is not valid.";
      case "not_found": return "That is gone. Reload the page.";
      case "limited_device": return "This device may only add a passkey.";
    }
    // These server messages are written for the owner and name what to fix (a machine name, a field); every other
    // code gets the generic line, so an internal or unexpected message never reaches the page.
    if (SHOWN_AS_SENT.has(err.code)) return err.message;
    return "Something went wrong. Try again.";
  }
  if (name === "TypeError") return "Could not reach Convoz. Check your connection and try again.";
  return "Something went wrong. Try again.";
}

// ---- WebAuthn tickets --------------------------------------------------------------------------------

const parseGet = (options) => PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey);
const parseCreate = (options) => PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey);

/**
 * A Ticket holds the options of one ceremony, fetched before the tap. `refresh` fetches again (a ceremony is single
 * use and lives 5 minutes); `use` starts the browser prompt and must be called straight from a click or submit handler.
 * `onchange` fires when ready flips, so the button can follow it.
 */
const TICKET_MAX_AGE = 3 * 60_000; // the server keeps a ceremony 5 minutes; leave time for the prompt itself
const tickets = new Set();

function ticket(kind, load, onError) {
  const t = { ready: false, data: null, gen: 0, timer: 0, at: 0, onchange() {} };
  /** stale: the options are too old to start a prompt with (a page that slept keeps a ticket the server forgot). */
  t.stale = () => t.ready && Date.now() - t.at > TICKET_MAX_AGE;
  t.refresh = async () => {
    const gen = ++t.gen;
    tickets.add(t);
    clearTimeout(t.timer);
    t.ready = false;
    t.data = null;
    t.onchange();
    try {
      const data = await load();
      if (gen !== t.gen) return;
      t.data = data;
      t.ready = true;
      t.at = Date.now();
      t.timer = setTimeout(t.refresh, TICKET_MAX_AGE); // before the server forgets it
    } catch (err) {
      if (gen === t.gen && onError) onError(err);
    }
    if (gen === t.gen) t.onchange();
  };
  t.use = () => {
    const { ceremony_id: id, publicKey } = t.data;
    t.ready = false;
    t.data = null;
    clearTimeout(t.timer);
    t.onchange();
    const prompt = kind === "get" ? navigator.credentials.get({ publicKey }) : navigator.credentials.create({ publicKey });
    return prompt.then((credential) => ({ ceremony_id: id, credential: credential.toJSON() }));
  };
  t.drop = () => {
    t.gen++;
    clearTimeout(t.timer);
    t.ready = false;
    tickets.delete(t);
    t.onchange();
  };
  return t;
}

// A hidden tab throttles timers, so a ticket can outlive the server's copy. Coming back to the page fetches again.
function refreshStale() {
  if (document.visibilityState === "hidden") return;
  for (const t of tickets) if (t.stale()) t.refresh();
}
document.addEventListener("visibilitychange", refreshStale);
window.addEventListener("pageshow", refreshStale);

const loginTicket = (onError) => ticket("get", async () => {
  const s = await api("POST", "/api/auth/passkey/login/options", {});
  return { ceremony_id: s.ceremony_id, publicKey: parseGet(s.options) };
}, onError);

const stepUpTicket = (action, target, onError) => ticket("get", async () => {
  const s = await api("POST", "/api/auth/step-up/options", target == null ? { action } : { action, target_id: target });
  return { ceremony_id: s.ceremony_id, publicKey: parseGet(s.options) };
}, onError);

const registerTicket = (onError) => ticket("create", async () => {
  const s = await api("POST", "/api/auth/passkey/register/options", {});
  return { ceremony_id: s.ceremony_id, publicKey: parseCreate(s.options) };
}, onError);

const bootstrapTicket = (fetchOptions, onError) => ticket("create", async () => {
  const s = await fetchOptions();
  return { ceremony_id: s.ceremony_id, publicKey: parseCreate(s.options) };
}, onError);

/** stepUp finishes a get ceremony that `ticket.use()` started and returns the step-up id for X-Convoz-Step-Up. */
async function finishStepUp(started) {
  const done = await api("POST", "/api/auth/step-up/verify", await started);
  return String(done.step_up_id);
}

/**
 * ceremonyButton runs `go` when `button` is tapped. The button is disabled while the ticket is not ready or while a
 * tap is being handled, and after every try (good or bad) the ticket is fetched again. `go` must call `ticket.use()`
 * before its first await. Failures show in `root`; `onError(err)` sees them first. A ticket that went stale before the tap is
 * fetched again and the person is asked to tap once more: a prompt started with options the server forgot would fail late.
 */
function ceremonyButton(button, t, go, { root = $("main"), also = () => true, alive = () => true, onError = () => {} } = {}) {
  let busy = false;
  const sync = () => {
    button.disabled = busy || !t.ready || !also();
    button.setAttribute("aria-busy", String(busy));
  };
  t.onchange = sync;
  sync();
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    if (t.stale()) {
      t.refresh();
      fail("That passkey check was waiting too long. Tap again when the button is ready.", root);
      return;
    }
    fail("", root);
    busy = true;
    try {
      await go();
    } catch (err) {
      onError(err);
      fail(humanError(err), root);
    } finally {
      busy = false;
      sync();
      if (!t.ready && !leaving && alive()) t.refresh();
    }
  });
  return sync;
}

// ---- recovery codes: shown once, copy and download ---------------------------------------------------

function codesBlock(codes) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      say("Copied. Keep the codes somewhere safe.");
    } catch {
      fail("Copying did not work. Select the codes and copy them by hand.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${codes.join("\n")}\n`], { type: "text/plain" }));
    const link = el("a", { href: url, download: "convoz-recovery-codes.txt" });
    body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return [
    el("ol", { class: "codes", "aria-label": "Recovery codes" }, ...codes.map((c) => el("li", {}, c))),
    el("div", { class: "pair" },
      el("button", { class: "btn", type: "button", onclick: copy }, "Copy codes"),
      el("button", { class: "btn", type: "button", onclick: download }, "Download codes")),
  ];
}

// ---- sheets ------------------------------------------------------------------------------------------

/**
 * openSheet shows a modal sheet named `title`. `build(form)` adds the content, `actions` are the buttons pinned at the
 * bottom. Returns {dialog, form, close}. `onClose` runs however it closes (Cancel, Escape, done).
 */
function openSheet(title, build, actions, onClose) {
  fail("");
  const dialog = el("dialog", { "aria-label": title });
  const form = el("form", { novalidate: true }, el("h2", {}, title));
  build(form);
  form.append(el("div", { class: "sheet-actions" }, ...actions));
  dialog.append(form);
  const sheet = { dialog, form, closed: false };
  sheet.close = () => {
    sheet.closed = true;
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener("close", () => {
    sheet.closed = true;
    if (onClose) onClose();
    dialog.remove();
  });
  body.append(dialog);
  dialog.showModal();
  return sheet;
}

const cancelButton = (close) => el("button", { class: "btn quiet", type: "button", onclick: close }, "Cancel");

/** field builds a label above a text input; the input is returned on `.input`. */
function field(label, attrs, hint) {
  const id = uid("f");
  const input = el("input", { id, name: id, type: "text", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", ...attrs });
  const box = el("div", { class: "field" }, el("label", { for: id }, label), input, hint ? el("p", { class: "hint" }, hint) : null);
  return { box, input };
}

/**
 * stepUpSheet asks for one passkey check and then runs `perform(stepId, values)`. The check's options are fetched when
 * the sheet opens; the confirm button waits for them. A failure shows in the sheet and the next tap is a fresh check.
 */
function stepUpSheet({ title, intro, fields = [], confirm, action, target, perform, tone }) {
  const inputs = {};
  const t = stepUpTicket(action, target, (err) => fail(humanError(err), dialogRoot()));
  const button = el("button", { class: `btn ${tone === "danger" ? "danger" : "primary"}`, type: "submit", disabled: true }, confirm);
  let sheet;
  const dialogRoot = () => sheet.dialog;
  sheet = openSheet(title, (form) => {
    if (intro) form.append(el("p", { class: "muted" }, intro));
    for (const f of fields) {
      const made = field(f.label, f.attrs, f.hint);
      inputs[f.key] = made.input;
      form.append(made.box);
    }
  }, [button, cancelButton(() => sheet.close())], () => t.drop());
  const submit = ceremonyButton(button, t, async () => {
    const values = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
    const stepId = await finishStepUp(t.use());
    await perform(stepId, values);
    sheet.close();
  }, { root: sheet.dialog, alive: () => !sheet.closed });
  sheet.form.addEventListener("submit", (event) => event.preventDefault()); // the click handler runs the ceremony
  submit();
  t.refresh();
  return { inputs, sheet };
}

// ---- add a passkey: tap 1 "Confirm it's you" (get), tap 2 "Create the new passkey" (create) -----------

function addPasskeySheet(onAdded) {
  let phase = "check";
  let stepId = null;
  let sheet;
  const showError = (err) => fail(humanError(err), sheet.dialog);
  const check = stepUpTicket("passkey.add", null, showError);
  const create = registerTicket(showError);
  const button = el("button", { class: "btn primary", type: "button", disabled: true }, "Confirm it's you");
  sheet = openSheet("Add a passkey", (form) => {
    form.append(
      el("p", { class: "muted" }, "First confirm it is you with a passkey you already have. Then create the new one on the device or security key you want to add."),
    );
  }, [button, cancelButton(() => sheet.close())], () => {
    check.drop();
    create.drop();
  });
  const setPhase = (next) => {
    phase = next;
    button.textContent = phase === "check" ? "Confirm it's you" : "Create the new passkey";
  };
  // The one ticket ceremonyButton sees is whichever of the two the next tap needs.
  const current = {
    get ready() { return (phase === "check" ? check : create).ready; },
    set onchange(fn) { check.onchange = fn; create.onchange = fn; },
    stale: () => (phase === "check" ? check : create).stale(),
    refresh: () => (phase === "check" ? check : create).refresh(),
  };
  ceremonyButton(button, current, async () => {
    if (phase === "check") {
      stepId = await finishStepUp(check.use()); // tap 1: the browser prompt opens at once
      setPhase("create");
      check.refresh(); // the next tap that needs a check starts from fresh options
      return;
    }
    const started = await create.use(); // tap 2
    await api("POST", "/api/auth/passkey/register/verify", started, { "X-Convoz-Step-Up": stepId });
    sheet.close();
    onAdded();
  }, {
    root: sheet.dialog,
    alive: () => !sheet.closed,
    onError: (err) => {
      if (err instanceof ApiError && err.code === "step_up_invalid") {
        setPhase("check");
        create.refresh();
      }
    },
  });
  check.refresh();
  create.refresh();
}

// ---- pages -------------------------------------------------------------------------------------------

const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function signOut() {
  try {
    await api("POST", "/api/auth/logout", {});
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      fail(humanError(err));
      return;
    }
  }
  leaving = true;
  location.assign("/signin?signed_out=1");
}

function setHeading(text) {
  const h = $("#heading");
  h.textContent = text;
  h.hidden = false;
  document.title = `${text} - Convoz`;
}

function showStep(text) {
  $("#heading").before(el("p", { class: "step" }, text));
}

const supported = () => "PublicKeyCredential" in window && "parseCreationOptionsFromJSON" in PublicKeyCredential;

let active = null; // the setup page's ticket, dropped when a different link replaces it

const pages = {
  // ---- first run --------------------------------------------------------------------------------------
  async bootstrap() {
    const view = $("#view");
    const token = location.hash.slice(1);
    // A different link in the same tab (only the #fragment changes, so the page is not reloaded) starts over.
    window.addEventListener("hashchange", () => {
      active?.drop();
      document.querySelector(".step")?.remove();
      $("#heading").hidden = true;
      fail("");
      say("");
      view.replaceChildren(el("p", { class: "muted" }, "Checking your setup link."));
      pages.bootstrap();
    }, { once: true });
    const dead = async (title) => {
      setHeading(title);
      let signedIn = false;
      try {
        signedIn = !(await api("GET", "/api/me")).device.limited;
      } catch {
        /* no session */
      }
      view.replaceChildren(
        el("p", { class: "lead" }, "Setup links work once and only for ten minutes."),
        signedIn
          ? el("div", { class: "actions" }, el("a", { class: "btn primary", href: "/" }, "Go to Convoz"))
          : el("div", {}, el("p", {}, "To get a new link, run this on the server:"), el("p", {}, el("code", {}, "convoz admin bootstrap-link"))),
      );
    };
    if (!token) return dead("This link is not valid");
    let check;
    try {
      check = await api("POST", "/api/auth/bootstrap/check", { token });
    } catch (err) {
      fail(humanError(err));
      return;
    }
    if (check.state !== "ok") return dead({ used: "This link was already used", expired: "This link expired" }[check.state] || "This link is not valid");
    if (!supported()) {
      setHeading("Passkeys are not available");
      view.replaceChildren(el("p", {}, "This browser cannot make passkeys. Open the link in Safari, Chrome or Edge."));
      return;
    }
    showStep("Step 1 of 3");
    setHeading("Welcome to Convoz");
    const handle = field("Handle", { autocomplete: "username", maxlength: "40", required: "" }, "Lowercase letters, numbers and dashes. It starts with a letter and never changes.");
    const display = field("Display name", { autocomplete: "name", autocapitalize: "words", maxlength: "80", required: "" });
    const button = el("button", { class: "btn primary", type: "submit", disabled: true }, "Register passkey");
    const form = el("form", { class: "stack", novalidate: true },
      el("p", { class: "lead" }, "Convoz is your private workspace for people and agents. Create the first passkey to own it."), handle.box, display.box,
      el("div", { class: "actions" }, button));
    view.replaceChildren(form);

    // One ticket for the whole form: it reads the fields when it fetches, and a change of either field voids it.
    const t = (active = bootstrapTicket(async () => {
      return api("POST", "/api/auth/bootstrap/options", { token, handle: handle.input.value, display_name: display.input.value.trim() });
    }, (err) => fail(humanError(err))));
    const valid = () => /^[a-z][a-z0-9-]{1,39}$/.test(handle.input.value) && display.input.value.trim().length > 0;
    ceremonyButton(button, t, async () => {
      const started = await t.use(); // the passkey prompt opens at once: the options were fetched before the tap
      const done = await api("POST", "/api/auth/bootstrap/verify", started);
      leaving = true; // the link is spent: no more options to fetch
      if (done.recovery_codes) pages.codes(done.recovery_codes);
      else location.assign("/");
    }, { also: valid });
    let timer = 0;
    const onInput = () => {
      clearTimeout(timer);
      t.drop();
      fail("");
      if (valid()) timer = setTimeout(t.refresh, 350); // wait for a pause in typing, then fetch
    };
    handle.input.addEventListener("input", onInput);
    display.input.addEventListener("input", onInput);
    form.addEventListener("submit", (event) => event.preventDefault());
  },

  // Step 2 of 3: the codes live in memory only; nothing is stored for a later visit.
  codes(codes) {
    document.querySelector(".step")?.remove();
    showStep("Step 2 of 3");
    setHeading("Save your recovery codes");
    const saved = el("input", { type: "checkbox", id: "saved" });
    const next = el("button", { class: "btn primary", type: "button", disabled: true, onclick: () => location.assign("/onboarding") }, "Continue");
    saved.addEventListener("change", () => {
      next.disabled = !saved.checked;
    });
    $("#view").replaceChildren(
      el("p", { class: "lead" }, "Each code works once. Use one if you ever lose your passkey. Convoz shows them only now."),
      ...codesBlock(codes),
      el("div", { class: "actions" }, el("label", { class: "check" }, saved, el("span", {}, "I saved them")), next),
    );
    window.scrollTo(0, 0);
  },

  // Step 3 of 3
  onboarding() {
    showStep("Step 3 of 3");
    const phone = matchMedia("(pointer: coarse), (max-width: 600px)").matches;
    const done = el("p", { class: "lead" }, "Add a passkey on another device or a hardware key");
    const add = el("button", { class: "btn primary", type: "button" }, "Add a passkey");
    add.addEventListener("click", () => addPasskeySheet(() => {
      say("Passkey added. You now have a second way in.");
      add.hidden = true;
      skip.textContent = "Continue to Now";
    }));
    const skip = el("button", { class: "btn quiet", type: "button", onclick: () => location.assign("/") }, "Skip for now");
    $("#view").replaceChildren(
      done,
      phone ? el("p", { class: "muted" }, "On a phone, use your laptop or a security key for the second passkey.") : null,
      el("p", { class: "muted" }, "A second passkey keeps you from being locked out if you lose this one."),
      el("div", { class: "actions" }, add, skip),
    );
  },

  // ---- sign in ----------------------------------------------------------------------------------------
  async signin() {
    const params = new URLSearchParams(location.search);
    const next = params.has("next") ? safeNext(params.get("next")) : "/"; // the app opens on Now
    if (params.has("signed_out")) say("Signed out");
    api("GET", "/api/me").then((me) => {
      if (!me.device.limited) location.replace(next);
    }).catch(() => {});
    if (!supported()) {
      fail("This browser cannot use passkeys. Try Safari, Chrome or Edge.");
      return;
    }
    const button = $("#signin");
    const t = loginTicket((err) => fail(humanError(err)));
    ceremonyButton(button, t, async () => {
      const started = await t.use(); // the prompt opens at once
      await api("POST", "/api/auth/passkey/login/verify", started);
      leaving = true;
      location.assign(next);
    });
    t.refresh();
  },

  recover() {
    $("#recover-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      fail("");
      try {
        await api("POST", "/api/auth/recovery", { code: $("#code").value.replace(/\s+/g, "") });
      } catch (err) {
        fail(humanError(err));
        return;
      }
      const t = registerTicket((err) => fail(humanError(err)));
      const button = el("button", { class: "btn primary", type: "button", disabled: true }, "Add a passkey");
      $("#view").replaceChildren(
        el("p", { class: "lead" }, "Code accepted. Add a passkey on this device to finish."),
        el("div", { class: "actions" }, button),
      );
      ceremonyButton(button, t, async () => {
        const started = await t.use(); // one create prompt, at once
        await api("POST", "/api/auth/passkey/register/verify", started);
        leaving = true;
        location.assign("/");
      });
      t.refresh();
    });
  },

  // ---- Now --------------------------------------------------------------------------------------------
  async now() {
    const me = await api("GET", "/api/me");
    const notes = $("#notes");
    if (me.recovery && me.recovery.hold_until) {
      notes.append(el("p", { class: "banner", role: "status" }, `You signed in with a recovery code. Codes left: ${me.recovery.codes_left}. Some actions are paused for 24 hours.`));
    }
    const { passkeys } = await api("GET", "/api/me/passkeys");
    if (passkeys.length === 1) {
      notes.append(el("div", { class: "card note" }, el("span", {}, "One passkey guards this account."), el("a", { href: "/settings/passkeys" }, "Add a second way in")));
    }
    await showRequests();
  },

  async machines() {
    const box = $("#machines");
    const reload = async () => {
      const { machines } = await api("GET", "/api/machines");
      box.replaceChildren(machines.length
        ? el("ul", { class: "group" }, ...machines.map((m) => machineItem(m, reload)))
        : el("p", { class: "empty" }, "No machines yet. Run convoz login on one."));
    };
    await reload();
  },

  // ---- account ----------------------------------------------------------------------------------------
  async account() {
    const me = await api("GET", "/api/me");
    $("#who").textContent = `${me.identity.display_name} (@${me.identity.handle})`;
    $("#signout-row").addEventListener("click", signOut);
  },

  async passkeys() {
    const list = $("#passkeys");
    let known = null;
    let rows = [];
    const via = { bootstrap: "Added with the setup link", session: "Added in settings", recovery: "Added with a recovery code" };
    const load = async () => {
      const { passkeys } = await api("GET", "/api/me/passkeys");
      const fresh = new Set(known ? passkeys.filter((p) => !known.has(p.id)).map((p) => p.id) : []);
      known = new Set(passkeys.map((p) => p.id));
      rows = passkeys;
      list.replaceChildren(...passkeys.map((p) => el("li", { class: "row" },
        el("div", { class: "grow" },
          el("strong", {}, p.label),
          p.this_device ? el("span", { class: "badge" }, "This device") : null,
          el("div", { class: "sub" }, `${via[p.registered_via] || "Added"}${fresh.has(p.id) ? " · Added just now" : ""}`),
          el("div", { class: "sub" }, p.last_used_at ? `Last used ${fmtDate(p.last_used_at)}` : "Never used")),
        el("button", { class: "btn small", type: "button", onclick: () => remove(p) }, "Remove passkey"))));
    };
    const remove = (p) => {
      if (rows.length <= 1) {
        fail("Another passkey must be added first.");
        return;
      }
      stepUpSheet({
        title: "Remove passkey",
        intro: `Remove "${p.label}"${p.this_device ? ", the one this device uses" : ""}? It can no longer sign in to Convoz.`,
        confirm: "Remove", tone: "danger", action: "passkey.remove", target: p.id,
        perform: async (stepId) => {
          await api("DELETE", `/api/me/passkeys/${p.id}`, {}, { "X-Convoz-Step-Up": stepId });
          await load();
        },
      });
    };
    $("#add").addEventListener("click", () => addPasskeySheet(load));
    await load();
  },

  async recovery() {
    const left = $("#left");
    const fresh = $("#fresh");
    const button = $("#make");
    const count = async () => {
      const { remaining } = await api("GET", "/api/me/recovery-codes");
      left.textContent = `${remaining} of 10 codes left`;
    };
    const t = stepUpTicket("recovery.regenerate", null, (err) => fail(humanError(err)));
    ceremonyButton(button, t, async () => {
      const stepId = await finishStepUp(t.use()); // one get prompt, at once
      const done = await api("POST", "/api/me/recovery-codes", {}, { "X-Convoz-Step-Up": stepId });
      fresh.replaceChildren(el("p", { class: "banner" }, "Your new codes. Save them now: they are shown only once. The old codes no longer work."), ...codesBlock(done.recovery_codes));
      await count();
    });
    t.refresh();
    await count();
  },
};

// ---- machine requests (Now) --------------------------------------------------------------------------

function parseAllow(text) {
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  return { mode: "list", identities: entries.filter((e) => !/[*?]/.test(e)), globs: entries.filter((e) => /[*?]/.test(e)) };
}

const allowText = (allow) => (allow.mode === "any" ? "any agent" : [...allow.identities, ...allow.globs].join(", ") || "no agent");

function sourceLine(req) {
  return `Source: ${req.node_name || "unknown"}${req.source_ip ? ` (${req.source_ip})` : ""}`;
}

function hostInfoLine(info) {
  return (info && [info.hostname, info.os, info.arch, info.cli_version].filter(Boolean).join(" · ")) || "nothing";
}

function approveSheet(req, pending, reload) {
  const fields = [{ key: "allowed", label: "Allowed identities", hint: "Agents this machine may act as: handles and patterns such as dev-*, separated by commas." }];
  if (pending.length > 1) fields.push({ key: "typed", label: "Type the code", hint: "Several machines are waiting. Type the code the machine printed.", attrs: { class: "code-input" } });
  stepUpSheet({
    title: `Approve ${req.name}`,
    fields, confirm: "Approve", action: "machine.approve", target: req.id,
    perform: async (stepId, values) => {
      const payload = { allow: parseAllow(values.allowed) };
      if (values.typed !== undefined) payload.typed_code = values.typed.trim();
      await api("POST", `/api/machines/requests/${req.id}/approve`, payload, { "X-Convoz-Step-Up": stepId });
      say(`Approved ${req.name}`);
      await reload();
    },
  });
}

function requestCard(req, pending, reload) {
  const name = `${req.name} wants to connect`;
  const id = uid("req");
  return el("article", { class: "card", "aria-labelledby": id },
    el("h3", { id }, name),
    el("p", {}, "Code: ", el("span", { class: "code" }, req.user_code)),
    el("p", { class: "sub" }, `Reported by the machine: ${hostInfoLine(req.host_info)}`),
    el("p", { class: "sub" }, sourceLine(req)),
    el("div", { class: "btns" },
      el("button", { class: "btn primary", type: "button", onclick: () => approveSheet(req, pending, reload) }, "Approve"),
      el("button", { class: "btn", type: "button", onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api("POST", `/api/machines/requests/${req.id}/deny`, {});
          say(`Denied ${req.name}`);
          await reload();
        } catch (err) {
          fail(humanError(err));
          event.currentTarget.disabled = false;
        }
      } }, "Deny")),
  );
}

/** showCount paints how many asks wait: "N open" in the top bar of Now and the badge on the Now tab (hidden at zero). */
function showCount(n) {
  const open = $("#open-count");
  if (open) {
    open.textContent = `${n} open`;
    open.hidden = false;
  }
  const badge = $("#now-badge");
  badge.textContent = n ? String(n) : "";
  badge.hidden = n === 0;
}

async function showRequests() {
  const list = $("#requests");
  const denyAll = $("#deny-all");
  const reload = async () => {
    const { machine_requests: pending } = await api("GET", "/api/now");
    $("#requests-block").hidden = pending.length === 0;
    $("#allclear").hidden = pending.length !== 0;
    denyAll.hidden = pending.length === 0;
    list.replaceChildren(...pending.map((req) => requestCard(req, pending, reload)));
    showCount(pending.length);
  };
  denyAll.addEventListener("click", async () => {
    try {
      await api("POST", "/api/machines/requests/deny-all", {});
      await reload();
    } catch (err) {
      fail(humanError(err));
    }
  });
  await reload();
}

// ---- machines ----------------------------------------------------------------------------------------

function showKey(title, key) {
  let sheet;
  const copy = el("button", { class: "btn", type: "button", onclick: async () => {
    try {
      await navigator.clipboard.writeText(key);
      say("Copied.");
    } catch {
      fail("Copying did not work. Select the key and copy it by hand.", sheet.dialog);
    }
  } }, "Copy key");
  sheet = openSheet(title, (form) => {
    form.append(el("p", { class: "muted" }, "Copy the key now. It is not shown again unless you reveal it with a passkey."), el("p", {}, el("output", { class: "mono", "aria-label": "Machine key" }, key)));
  }, [copy, el("button", { class: "btn primary", type: "button", onclick: () => sheet.close() }, "Done")]);
}

function machineItem(m, reload) {
  const act = (label, action, path, intro, tone) => el("button", { class: "btn small", type: "button", onclick: () => stepUpSheet({
    title: `${label} ${m.name}`, intro, confirm: label, tone, action, target: m.id,
    perform: async (stepId) => {
      const done = await api("POST", `/api/machines/${m.id}/${path}`, {}, { "X-Convoz-Step-Up": stepId });
      if (done.machine_key) showKey(`Key of ${m.name}`, done.machine_key);
      await reload();
    },
  }) }, label);
  const edit = () => {
    const made = stepUpSheet({
      title: `Allow-list of ${m.name}`, confirm: "Save", action: "machine.allow", target: m.id,
      fields: [{ key: "allowed", label: "Allowed identities", hint: "Handles and patterns such as dev-*, separated by commas. Use * for every agent." }],
      perform: async (stepId, values) => {
        const allow = values.allowed.trim() === "*" ? { mode: "any", identities: [], globs: [] } : parseAllow(values.allowed);
        await api("PATCH", `/api/machines/${m.id}`, { allow }, { "X-Convoz-Step-Up": stepId });
        await reload();
      },
    });
    made.inputs.allowed.value = m.allow.mode === "any" ? "*" : [...m.allow.identities, ...m.allow.globs].join(", ");
  };
  return el("li", { class: "row stacked" },
    el("div", {}, el("strong", {}, m.name), " ", el("code", {}, m.key_hint)),
    el("div", { class: "sub" }, `Allowed: ${allowText(m.allow)}. Scopes: ${m.scopes.join(", ")}. Live sessions: ${m.live_sessions}.`),
    el("div", { class: "sub" }, m.last_used_at ? `Last used ${fmtDate(m.last_used_at)}` : "Never used"),
    el("div", { class: "btns wrap" },
      act("Reveal", "machine.reveal", "reveal", "Show this machine's key once. This needs a passkey check."),
      act("Regenerate", "machine.regenerate", "regenerate", "Make a new key. The old key and its sessions stop working at once.", "danger"),
      act("Revoke", "machine.revoke", "revoke", "Its key and sessions stop working at once.", "danger"),
      el("button", { class: "btn small", type: "button", onclick: edit }, "Edit allow-list")),
  );
}

// ---- the frame: account menu --------------------------------------------------------------------------

function wireMenu() {
  const button = $("#account-button");
  const menu = $("#account-menu");
  if (!button) return;
  const items = [...menu.querySelectorAll("[role=menuitem]")];
  items.forEach((item) => item.setAttribute("tabindex", "-1")); // arrows move between them; Tab leaves the menu
  const set = (open) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const focusItem = (i) => items[(i + items.length) % items.length].focus();
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    set(menu.hidden);
    if (!menu.hidden) items[0].focus();
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) set(false);
  });
  document.addEventListener("keydown", (event) => {
    if (menu.hidden) return;
    const at = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      set(false);
      button.focus();
    } else if (event.key === "Tab") {
      set(false); // focus goes on to the next control as usual
    } else if (at >= 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focusItem({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key]);
    }
  });
  $("#signout").addEventListener("click", signOut);
}

// Cmd+J / Ctrl+J starts a new chat from anywhere in the signed-in console.
document.addEventListener("keydown", (event) => {
  if (!("shell" in body.dataset || "chat" in body.dataset)) return;
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
    event.preventDefault();
    if (location.pathname !== "/chats/new") location.assign("/chats/new");
  }
});

wireMenu();
// The Now tab counts what waits for the owner on every signed-in page; Now itself paints it from its own answer.
if ("shell" in body.dataset && PAGE !== "now") {
  api("GET", "/api/now").then((now) => showCount(now.machine_requests.length)).catch(() => {});
}
const start = pages[PAGE];
if (start) Promise.resolve(start()).catch((err) => fail(humanError(err)));
