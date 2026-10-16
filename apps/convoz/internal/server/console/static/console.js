"use strict";
// Owner console for S1. No framework. Text goes in with textContent only.

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

// ---- dialogs ---------------------------------------------------------------------------------------

// openSheet shows a modal dialog named `title` holding a form. `fields` are [label, id] pairs; `onSubmit`
// gets the values and may throw: the message shows in the sheet's own alert and the sheet stays open.
function openSheet(title, fields, submitLabel, onSubmit) {
  const sheet = el("dialog", { "aria-label": title });
  const form = el("form", {}, el("h2", {}, title));
  const inputs = {};
  for (const [label, id, hint] of fields) {
    inputs[id] = el("input", { id, name: id, autocomplete: "off" });
    form.append(el("p", {}, el("label", { for: id }, label), " ", inputs[id]));
    if (hint) form.append(el("p", {}, hint));
  }
  let alertBox = null;
  const fail = (message) => {
    if (!alertBox) {
      alertBox = el("p", { role: "alert" });
      form.append(alertBox);
    }
    alertBox.textContent = message;
  };
  const close = () => {
    sheet.close();
    sheet.remove();
  };
  form.append(el("p", {}, el("button", { type: "submit" }, submitLabel), " ", el("button", { type: "button", onclick: close }, "Cancel")));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (alertBox) alertBox.remove();
    alertBox = null;
    try {
      await onSubmit(Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, input.value])), close);
    } catch (err) {
      fail(err && err.message ? err.message : "Something went wrong.");
    }
  });
  sheet.append(form);
  document.body.append(sheet);
  sheet.showModal();
  return inputs;
}

// parseAllow reads "devtool, dev-*" into an allow-list: handles with * or ? are patterns.
function parseAllow(text) {
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  return {
    mode: "list",
    identities: entries.filter((e) => !/[*?]/.test(e)),
    globs: entries.filter((e) => /[*?]/.test(e)),
  };
}

function allowText(allow) {
  return allow.mode === "any" ? "any agent" : [...allow.identities, ...allow.globs].join(", ") || "no agent";
}

// ---- machine requests (Now) ------------------------------------------------------------------------

function sourceLine(req) {
  return req.node_name ? `Source: ${req.node_name}${req.source_ip ? ` (${req.source_ip})` : ""}` : "Source: unknown";
}

function hostInfoLine(info) {
  if (!info) return "nothing";
  return [info.hostname, info.os, info.arch, info.cli_version].filter(Boolean).join(" · ") || "nothing";
}

function approveSheet(req, pending, reload) {
  const fields = [["Allowed identities", "allowed", "Agents this machine may act as: handles and patterns such as dev-*, separated by commas."]];
  if (pending.length > 1) fields.push(["Type the code", "typed", "Several machines are waiting. Type the code the machine printed."]);
  openSheet(`Approve ${req.name}`, fields, "Approve", async (values, close) => {
    const stepId = await stepUp("machine.approve", req.id);
    const body = { allow: parseAllow(values.allowed) };
    if (values.typed !== undefined) body.typed_code = values.typed.trim();
    await api("POST", `/api/machines/requests/${req.id}/approve`, body, { "X-Convoz-Step-Up": stepId });
    close();
    await reload();
  });
}

function requestCard(req, pending, reload) {
  return el("article", { "aria-label": `${req.name} wants to connect` },
    el("h3", {}, `${req.name} wants to connect`),
    el("p", {}, "Code: ", el("strong", {}, req.user_code)),
    el("p", {}, `Reported by the machine: ${hostInfoLine(req.host_info)}`),
    el("p", {}, sourceLine(req)),
    el("p", {},
      el("button", { type: "button", onclick: () => approveSheet(req, pending, reload) }, "Approve"), " ",
      el("button", { type: "button", onclick: run(async () => { await api("POST", `/api/machines/requests/${req.id}/deny`, {}); await reload(); }) }, "Deny"),
    ),
  );
}

async function showRequests() {
  const list = $("#requests");
  const denyAll = $("#deny-all");
  const reload = async () => {
    const { machine_requests: pending } = await api("GET", "/api/now");
    denyAll.hidden = pending.length === 0;
    list.replaceChildren(...(pending.length ? pending.map((req) => requestCard(req, pending, reload)) : [el("p", {}, "No machine requests")]));
  };
  denyAll.addEventListener("click", run(async () => { await api("POST", "/api/machines/requests/deny-all", {}); await reload(); }));
  await reload();
}

// ---- machines --------------------------------------------------------------------------------------

// showKey shows a key once, in a sheet; closing it forgets it.
function showKey(title, key) {
  const sheet = el("dialog", { "aria-label": title }, el("h2", {}, title),
    el("p", {}, "Copy the key now. It is not shown again unless you reveal it with a passkey."),
    el("p", {}, el("output", { "aria-label": "Machine key" }, key)),
    el("p", {}, el("button", { type: "button", onclick: run(async () => { await navigator.clipboard.writeText(key); status("Copied."); }) }, "Copy key"), " ",
      el("button", { type: "button", onclick: () => { sheet.close(); sheet.remove(); } }, "Done")));
  document.body.append(sheet);
  sheet.showModal();
}

function machineItem(m, reload) {
  const act = (label, action, path, after) => el("button", { type: "button", onclick: run(async () => {
    if (action === "machine.revoke" && !confirm(`Revoke ${m.name}? Its key and sessions stop working at once.`)) return;
    if (action === "machine.regenerate" && !confirm(`Regenerate the key of ${m.name}? The old key and its sessions stop working at once.`)) return;
    const stepId = await stepUp(action, m.id);
    const done = await api("POST", `/api/machines/${m.id}/${path}`, {}, { "X-Convoz-Step-Up": stepId });
    if (done.machine_key) showKey(`Key of ${m.name}`, done.machine_key);
    await reload();
  }) }, label);
  return el("section", { "aria-label": m.name },
    el("p", {}, el("strong", {}, m.name), " ", el("code", {}, m.key_hint)),
    el("p", {}, `Allowed: ${allowText(m.allow)}. Scopes: ${m.scopes.join(", ")}. Live sessions: ${m.live_sessions}.`),
    el("p", {}, m.last_used_at ? `Last used ${new Date(m.last_used_at).toLocaleString()}` : "Never used"),
    el("p", {}, act("Reveal", "machine.reveal", "reveal"), " ", act("Regenerate", "machine.regenerate", "regenerate"), " ", act("Revoke", "machine.revoke", "revoke"), " ",
      el("button", { type: "button", onclick: () => editAllow(m, reload) }, "Edit allow-list")),
  );
}

function editAllow(m, reload) {
  const inputs = openSheet(`Allow-list of ${m.name}`, [["Allowed identities", "allowed", "Handles and patterns such as dev-*, separated by commas. Use * for every agent."]], "Save", async (values, close) => {
    const stepId = await stepUp("machine.allow", m.id);
    const allow = values.allowed.trim() === "*" ? { mode: "any", identities: [], globs: [] } : parseAllow(values.allowed);
    await api("PATCH", `/api/machines/${m.id}`, { allow }, { "X-Convoz-Step-Up": stepId });
    close();
    await reload();
  });
  inputs.allowed.value = m.allow.mode === "any" ? "*" : [...m.allow.identities, ...m.allow.globs].join(", ");
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
    await showRequests();
  },

  async machines() {
    const box = $("#machines");
    const reload = async () => {
      const { machines } = await api("GET", "/api/machines");
      box.replaceChildren(...(machines.length ? [el("ul", {}, ...machines.map((m) => el("li", {}, machineItem(m, reload))))] : [el("p", {}, "No machines yet. Run convoz login on one.")]));
    };
    await reload();
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
