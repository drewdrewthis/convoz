"use strict";
// Owner console for S1a. No framework. Text goes in with textContent only.

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function showError(message) {
  let box = $("#alert");
  if (!box) {
    box = el("p", { id: "alert", role: "alert" });
    $("main").append(box);
  }
  box.textContent = message;
}

function clearError() {
  const box = $("#alert");
  if (box) box.remove();
}

async function api(method, path, body, headers) {
  const init = {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Convoz": "1", ...(headers || {}) },
  };
  if (method !== "GET") init.body = JSON.stringify(body ?? {});
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 204 or no body */
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || res.statusText);
    err.code = data && data.error && data.error.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// run wraps a click or submit handler: errors go to the alert box, never to the console only.
function run(fn) {
  return async (event) => {
    if (event) event.preventDefault();
    clearError();
    try {
      await fn(event);
    } catch (err) {
      showError(err && err.message ? err.message : "Something went wrong.");
    }
  };
}

const createCredential = async (options) =>
  (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey) })).toJSON();

const getCredential = async (options) =>
  (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey) })).toJSON();

// stepUp asks for a passkey for one action and returns the step-up id for X-Convoz-Step-Up.
async function stepUp(action, targetId) {
  const body = targetId == null ? { action } : { action, target_id: targetId };
  const started = await api("POST", "/api/auth/step-up/options", body);
  const credential = await getCredential(started.options);
  const done = await api("POST", "/api/auth/step-up/verify", { ceremony_id: started.ceremony_id, credential });
  return String(done.step_up_id);
}

// addPasskey registers another passkey. A recovery (limited) device has no passkey to step up with.
async function addPasskey(limited) {
  const headers = limited ? {} : { "X-Convoz-Step-Up": await stepUp("passkey.add") };
  const started = await api("POST", "/api/auth/passkey/register/options", {});
  const credential = await createCredential(started.options);
  await api("POST", "/api/auth/passkey/register/verify", { ceremony_id: started.ceremony_id, credential }, headers);
}

function status(text) {
  let box = $("#status");
  if (!box) {
    box = el("p", { id: "status" });
    $("main").append(box);
  }
  box.textContent = text;
}

// renderOnboarding shows the second-passkey step. Recovery codes are shown only when `codes` is given,
// which happens once, right after the first passkey; nothing is kept for a later visit.
function renderOnboarding(codes) {
  $("#heading").textContent = "Set up a second way in";
  document.title = "Set up a second way in - Convoz";
  const view = $("#view");
  view.replaceChildren(
    el("p", {}, "Add a passkey on another device or a hardware key"),
    el("p", {}, el("button", { type: "button", onclick: run(async () => { await addPasskey(false); status("Passkey added."); }) }, "Add a passkey")),
  );
  if (codes) {
    view.append(
      el("h2", {}, "Recovery codes"),
      el("p", {}, "Save these codes now. Each works once. They are not shown again."),
      el("ol", { "aria-label": "Recovery codes" }, ...codes.map((c) => el("li", {}, c))),
      el("p", {}, el("button", { type: "button", onclick: run(async () => { await navigator.clipboard.writeText(codes.join("\n")); status("Copied."); }) }, "Copy codes")),
    );
  }
  view.append(el("p", {}, el("button", { type: "button", onclick: () => location.assign("/") }, "Continue")));
}

const pages = {
  bootstrap() {
    $("#bootstrap-form").addEventListener("submit", run(async () => {
      const token = location.hash.slice(1);
      if (!token) throw new Error("This link is not valid.");
      const started = await api("POST", "/api/auth/bootstrap/options", { token, handle: $("#handle").value, display_name: $("#display").value });
      const credential = await createCredential(started.options);
      const done = await api("POST", "/api/auth/bootstrap/verify", { ceremony_id: started.ceremony_id, credential });
      renderOnboarding(done.recovery_codes || null);
    }));
  },

  signin() {
    $("#signin").addEventListener("click", run(async () => {
      const started = await api("POST", "/api/auth/passkey/login/options", {});
      const credential = await getCredential(started.options);
      await api("POST", "/api/auth/passkey/login/verify", { ceremony_id: started.ceremony_id, credential });
      location.assign("/");
    }));
  },

  recover() {
    $("#recover-form").addEventListener("submit", run(async () => {
      await api("POST", "/api/auth/recovery", { code: $("#code").value });
      $("#view").replaceChildren(
        el("p", {}, "Code accepted. Add a passkey to finish."),
        el("p", {}, el("button", { type: "button", onclick: run(async () => { await addPasskey(true); location.assign("/signin"); }) }, "Add a passkey")),
      );
    }));
  },

  async now() {
    const me = await api("GET", "/api/me");
    $("#who").textContent = `Signed in as ${me.identity.display_name} (@${me.identity.handle}).`;
    $("#signout").addEventListener("click", run(async () => {
      await api("POST", "/api/auth/logout", {});
      location.assign("/signin");
    }));
  },

  onboarding() {
    renderOnboarding(null);
  },

  async passkeys() {
    const list = $("#passkeys");
    const load = async () => {
      const { passkeys } = await api("GET", "/api/me/passkeys");
      list.replaceChildren(...passkeys.map((p) => el("li", {},
        `${p.label} `,
        el("button", { type: "button", onclick: run(async () => {
          const sid = await stepUp("passkey.remove", p.id);
          await api("DELETE", `/api/me/passkeys/${p.id}`, {}, { "X-Convoz-Step-Up": sid });
          await load();
        }) }, "Remove passkey"),
      )));
    };
    $("#add").addEventListener("click", run(async () => { await addPasskey(false); await load(); }));
    await load();
  },
};

const start = pages[document.body.dataset.page];
if (start) Promise.resolve(start()).catch((err) => showError(err.message));
