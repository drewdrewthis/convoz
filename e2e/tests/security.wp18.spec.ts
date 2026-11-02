import { agentPost, createConversation, ownerSays, startSession } from "../lib/chat.ts";
import { askBody, postAsk } from "../lib/asks.ts";
import { ackApi, inboxApi, itemsOf } from "../lib/inbox.ts";
import { Client } from "../lib/http.ts";
import { allow, lease as mintLease, loginMachine, mintSession, plainDb, sessionsOf, stepUp, stepped, withStepUp } from "../lib/machines.ts";
import { msgWorld, pageOf } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import {
  authzOfLive,
  call,
  codeOf,
  concrete,
  isApi,
  LEASE_REFUSED,
  liveRoutes,
  loadContract,
  memberDevice,
  messageOf,
  normalize,
  type Authz,
  type ContractOp,
} from "../lib/security-wp18.ts";
import { postWith, uploadWhole } from "../lib/uploads-wp10.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { browserWorld, openChat, world } from "../lib/wp3.ts";
import { message } from "../lib/chat-ui.ts";

/*
 * SECURITY, the matrix (WP18): the bindings of the API scenarios of specs/contracts/security.feature that run over every route.
 * The contract side is x-authz on each operation of packages/contracts/paths/*.yaml (see lib/security-wp18.ts); the server side is the
 * live route table, GET /__test/routes.
 *
 * DEFAULT (owner to confirm): "no credential" is a request with no cookie and no Authorization header that carries the Origin and
 * X-Convoz headers of the app. A write without them is told 403 csrf by the wall before authentication is looked at.
 */

const NO_CREDENTIAL = [
  "GET /api/me",
  "GET /api/now",
  "GET /api/conversations",
  "POST /api/conversations/41/messages",
  "GET /api/stream",
  "GET /api/inbox",
  "GET /api/brief",
  "GET /api/files/f_TESTONLY",
  "POST /api/machines/1/reveal",
];

scenario("API routes answer 401 without credentials", { tag: ["@api"] }, async ({ server }) => {
  // Background: owner "drew", machines "box-2" and "laptop-1" with allow-list "devtool"
  const w = await world(server, { agents: ["devtool"] });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));

  // When a client calls <route> with no credential
  const answers: string[] = [];
  for (const row of NO_CREDENTIAL) {
    const [method, route] = row.split(" ") as [string, string];
    const res = await call(w.srv, method, route);
    answers.push(`${row} -> ${res.status}${res.setCookie.length ? " (sets a cookie)" : ""}`);
  }

  // Then the server answers 401
  expect(answers).toEqual(NO_CREDENTIAL.map((row) => `${row} -> 401`));
});

scenario("Every route enforces the auth, scope and role its contract declares", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(120_000);
  // Background: owner "drew", machines "box-2" (the default scopes) and "laptop-1" with allow-list "devtool"; and a machine
  // with the create_identity scope only, so there is a lease that lacks every other scope
  const w = await world(server, { agents: ["devtool"], plaintext: true });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));
  const narrowMachine = await loginMachine(w.srv, w.owner, "narrow-only", allow("devtool"), { scopes: ["create_identity"] });
  const lease = (key: string, label: string) => mintLease(w.srv, key, { as: "devtool", label });
  const full = await lease(w.box2.key, "matrix-full");
  const narrow = await lease(narrowMachine.key, "matrix-narrow");
  const db = plainDb(dataDir);
  const member = memberDevice(db);
  let nextCode = 0;
  const recoveryDevice = async (): Promise<string> => {
    const c = new Client(w.srv.target);
    must(await c.post("/api/auth/recovery", { code: w.owner.codes[nextCode++]! }), "use a recovery code");
    return c.cookieHeader();
  };
  const limited = await recoveryDevice();

  // Given the OpenAPI contract lists the auth, scope and role of every route
  const contract = loadContract();
  const live = await liveRoutes(w.srv);
  const problems: string[] = [];
  const key = (method: string, p: string) => `${method} ${normalize(p)}`;
  const declared = new Map<string, ContractOp>();
  for (const op of contract.ops) {
    if (declared.has(key(op.method, op.path))) problems.push(`${key(op.method, op.path)}: listed twice in the contract`);
    declared.set(key(op.method, op.path), op);
  }
  const liveApi = new Map(live.filter((r) => isApi(r.pattern)).map((r) => [key(r.method, r.pattern), r]));

  // A route in the contract and not on the server, or the other way round, fails
  for (const k of declared.keys()) if (!liveApi.has(k)) problems.push(`${k}: in the contract, not in the live route table`);
  for (const k of liveApi.keys()) if (!declared.has(k)) problems.push(`${k}: in the live route table, not in the contract`);
  const listed = new Set(contract.listedPaths);
  for (const op of contract.ops) if (!listed.has(op.path)) problems.push(`${key(op.method, op.path)}: its path is not listed in openapi.yaml`);
  // Outside the API a route is a page for a signed-in person, a public file of the web app, or the owner's hidden /dev copy
  for (const r of live) {
    if (isApi(r.pattern) || r.pattern.startsWith("/__test/")) continue;
    if (r.auth !== "pub" && !(r.auth === "H" && r.page) && !(r.auth === "O" && r.hidden)) problems.push(`${r.method} ${r.pattern}: a web route that is neither public, a page, nor hidden for the owner`);
  }

  // The contract says what the server says, and says it consistently with its own security and header lists
  const canon = (a: Authz) => JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))));
  for (const [k, op] of declared) {
    const row = liveApi.get(k);
    const a = op.authz;
    if (!a) {
      problems.push(`${k}: no x-authz`);
      continue;
    }
    if (row && canon(a) !== canon(authzOfLive(row))) problems.push(`${k}: contract ${canon(a)}, server ${canon(authzOfLive(row))}`);
    const have = op.security === undefined ? ["deviceCookie"] : op.security.flatMap((s) => Object.keys(s));
    const accepts = a.auth === "lease" || a.lease === "accept";
    const want = a.auth === "pub" ? [] : a.auth === "machine" ? ["machineKey"] : a.auth === "lease" ? ["leaseBearer"] : accepts ? ["deviceCookie", "leaseBearer"] : ["deviceCookie"];
    if (JSON.stringify([...have].sort()) !== JSON.stringify([...want].sort())) problems.push(`${k}: security ${JSON.stringify(have)}, x-authz wants ${JSON.stringify(want)}`);
    if (!!a.step_up !== op.stepUpHeader) problems.push(`${k}: x-authz ${a.step_up ? "has" : "has no"} step_up but the X-Convoz-Step-Up header ${op.stepUpHeader ? "is" : "is not"} listed`);
  }

  // A hidden route tells a caller with no credential, and an agent's lease, 404, as for an unknown path
  for (const r of live.filter((x) => x.hidden)) {
    for (const [who, cred] of [["no credential", {}], ["a lease", { bearer: full }]] as const) {
      const res = await call(w.srv, "GET", concrete(r.pattern), cred);
      if (res.status !== 404) problems.push(`GET ${r.pattern} (hidden) with ${who}: wanted 404, got ${res.status}`);
    }
  }

  // A page sends a caller who is not signed in to the sign-in page
  for (const r of live.filter((x) => x.page)) {
    const res = await call(w.srv, "GET", concrete(r.pattern));
    if (res.status !== 302 || !String(res.headers.location).startsWith("/signin")) problems.push(`GET ${r.pattern} (page) with no credential: wanted a redirect to /signin, got ${res.status} ${res.headers.location ?? ""}`);
  }

  // When every route is called with no credential, with a lease that lacks its scope and with a non-owner role
  // (and with each other credential, which a route must not take)
  const owner = w.owner.client.cookieHeader();
  const probe = async (op: ContractOp, who: string, cred: Parameters<typeof call>[3], ok: (status: number, code?: string, message?: string) => boolean, wanted: string, route: string) => {
    const res = await call(w.srv, op.method, route, cred);
    if (!ok(res.status, codeOf(res), messageOf(res))) problems.push(`${op.method} ${op.path} (${op.authz!.auth}) with ${who}: wanted ${wanted}, got ${res.status} ${res.text.slice(0, 80)}`);
  };
  const ops = [...declared.values()].filter((o) => o.authz && o.authz.auth !== "pub");
  // a lease that ends its own session goes last
  ops.sort((x, y) => Number(x.operationId === "endSession") - Number(y.operationId === "endSession"));
  for (const op of ops) {
    const a = op.authz!;
    const route = concrete(op.path) + (op.path === "/api/inbox" ? "?wait=0" : "");
    const stream = op.path === "/api/stream";
    const leaseMeets = a.auth === "lease" || a.lease === "accept";
    const person = a.auth === "human" || a.auth === "limited" || a.auth === "owner";

    await probe(op, "no credential", {}, (s) => s === 401, "401", route);

    if (leaseMeets) {
      const holder = op.operationId === "endSession" ? await lease(w.box2.key, "matrix-ends") : full;
      await probe(op, "a lease with the scope", { bearer: holder }, (s, _c, m) => s !== 401 && !(s === 403 && m === LEASE_REFUSED), "the lease let in", route);
    } else if (a.lease === "refuse") {
      await probe(op, "a lease", { bearer: full }, (s, _c, m) => s === 403 && m === LEASE_REFUSED, `403 "${LEASE_REFUSED}"`, route);
    } else await probe(op, "a lease", { bearer: full }, (s) => s === 401, "401", route);

    if (a.scope && leaseMeets) await probe(op, `a lease without the ${a.scope} scope`, { bearer: narrow }, (s) => s === 403, "403", route);

    if (a.auth === "machine") await probe(op, "a machine key", { bearer: w.box2.key }, (s) => s !== 401, "the key let in", route);
    else await probe(op, "a machine key", { bearer: w.box2.key }, (s) => s === 401, "401", route);

    if (!person) {
      await probe(op, "the owner's cookie", { cookie: owner }, (s) => s === 401, "401", route);
      continue;
    }

    // a person who is not the owner
    const signsOut = op.operationId === "logout";
    const as = signsOut ? memberDevice(db) : member;
    if (a.auth === "owner") await probe(op, "a member", { cookie: as }, (s) => s === 403, "403", route);
    else if (!stream) await probe(op, "a member", { cookie: as }, (s) => s !== 401, "the member let in", route);

    // a recovery device: only a "limited" route takes it
    const recovery = signsOut ? await recoveryDevice() : limited;
    if (a.auth !== "limited") await probe(op, "a recovery device", { cookie: recovery }, (s, c) => s === 403 && (c === "limited_device" || op.method === "HEAD"), "403 limited_device", route); // a HEAD answer has no body to carry the code
    else if (!stream) await probe(op, "a recovery device", { cookie: recovery }, (s, c) => s !== 401 && c !== "limited_device", "the recovery device let in", route);

    // the owner's own device: a route with a step-up asks for it before it does anything
    if (a.step_up) await probe(op, "the owner and no step-up", { cookie: owner }, (s, c) => s === 403 && c === "step_up_required", "403 step_up_required", route);
  }

  // Then each call answers 401 or 403 exactly as the contract declares
  expect(problems).toEqual([]);
  expect(declared.size, "the matrix covers every route of the live table").toBe(liveApi.size);
});

const DATA_ACTIONS = ["POST /api/messages/88/purge", "POST /api/me/export", "POST /api/me/delete"];

scenario("Step-up is required for data actions", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));
  const kept = await ownerSays(w.owner, w.conv, "keep this text");

  // When the owner calls <action> with no step-up
  const answers: string[] = [];
  for (const row of DATA_ACTIONS) {
    const [method, route] = row.split(" ") as [string, string];
    const res = await w.owner.client.request(method, route, { csrf: true, json: {} });
    answers.push(`${row} -> ${res.status} ${codeOf(res)}`);
  }
  const purgeWithout = await w.owner.client.request("POST", `/api/messages/${kept}/purge`, { csrf: true, json: {} });
  answers.push(`POST /api/messages/${kept}/purge -> ${purgeWithout.status} ${codeOf(purgeWithout)}`);

  // Then the server answers 403 with the code "step_up_required", and nothing was done
  expect(answers).toEqual([...DATA_ACTIONS.map((row) => `${row} -> 403 step_up_required`), `POST /api/messages/${kept}/purge -> 403 step_up_required`]);

  // Control: with a step-up for the action the same routes let the owner in, so the step-up is what the 403 was about
  const control = [
    (await stepped(w.owner, "POST", "/api/me/export", {}, "data.export")).status,
    (await stepped(w.owner, "POST", "/api/me/delete", {}, "data.delete")).status,
    (await w.owner.client.request("POST", `/api/messages/${kept}/purge`, { csrf: true, json: {}, ...withStepUp(await stepUp(w.owner, "message.purge", kept)) })).status,
  ];
  expect(control, "export, delete (not built yet: 501), purge").toEqual([202, 501, 200]);
  expect((await pageOf(w.owner, w.conv)).find((m) => m.id === kept)?.purged).toBe(true);
});

scenario("The audit trail names machine and session", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background: owner "drew", machines "box-2" and "laptop-1" with allow-list "devtool"
  const w = await msgWorld({ server, dataDir });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));
  const minted = must(await mintSession(w.srv, w.box2.key, { as: "devtool", label: "claude-7f3a" }), "mint", 201).json();
  const token = minted.lease as string;
  const session = minted.session.id as number;
  await ownerSays(w.owner, w.conv, "@devtool look at this"); // an inbox item to ack

  // When "devtool" on "box-2" posts, asks, uploads and acks
  const post = must(await agentPost(w.srv, token, w.conv, "Build is green"), "post", 201).json().id as number;
  const ask = must(await postAsk(w.srv, token, askBody(w.conv)), "ask", 201).json().ask.id as number;
  const file = await uploadWhole({ srv: w.srv, lease: token }, w.conv, "file", "notes.txt", Buffer.from("TESTONLY notes"));
  const attached = await postWith({ srv: w.srv, lease: token }, w.conv, "Notes attached", [file.id]);
  if (attached.status !== 201) throw new Error(`post with a file: HTTP ${attached.status} ${attached.text}`);
  const withFile = attached.json().id as number;
  const items = await itemsOf(await inboxApi(w.srv, token, "wait=0"));
  must(await ackApi(w.srv, token, items.map((i) => ({ id: i.id, claim_token: i.claim_token }))), "ack");

  // Then each matching audit and message detail names machine "box-2" and the session label
  const origin = (m: { machine?: string; session_label?: string; session?: string }) => `${m.machine}/${m.session_label ?? m.session}`;
  const audit = must(await w.owner.client.get("/api/admin/audit"), "audit view").json().audit as { action: string; session_id: number | null; machine?: string; session?: string }[];
  const details = (await pageOf(w.owner, w.conv)).filter((m) => [post, ask, withFile].includes(m.id));
  const db = w.db();
  const sessions = await sessionsOf(w.owner);
  const named = (id: unknown) => sessions.filter((s) => s.id === id).map((s) => `${s.machine}/${s.label}`)[0];
  const stored = {
    upload: named((db.prepare("SELECT session_id AS s FROM uploads WHERE public_id = ?").get(file.id) as { s: number }).s),
    ask: named((db.prepare("SELECT asked_by_session AS s FROM asks WHERE message_id = ?").get(ask) as { s: number }).s),
    ack: items.map((i) => named((db.prepare("SELECT acked_by_session AS s FROM inbox_items WHERE id = ?").get(i.id) as { s: number }).s)),
  };
  db.close();
  expect(
    {
      audit: audit.filter((r) => r.session_id === session).map((r) => `${r.action} ${origin(r)}`).sort(),
      details: details.map((m) => origin(m)),
      stored,
    },
    "every audit row of the session and every message it wrote names box-2 and claude-7f3a",
  ).toEqual({
    // the post, the ask (an ask is a message), the post with a file, and the start of the session
    audit: ["message.post box-2/claude-7f3a", "message.post box-2/claude-7f3a", "message.post box-2/claude-7f3a", "session.started box-2/claude-7f3a"],
    details: ["box-2/claude-7f3a", "box-2/claude-7f3a", "box-2/claude-7f3a"],
    stored: { upload: "box-2/claude-7f3a", ask: "box-2/claude-7f3a", ack: ["box-2/claude-7f3a"] },
  });
});

scenario("A remote image never loads", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: owner "drew" signed in, machines "box-2" and "laptop-1" with allow-list "devtool"
  // (every API step-up happens before the browser takes the passkey, so its signature counter continues from there)
  const w = await browserWorld({ server, page, context }, { agents: ["devtool"], beforeSignIn: async (b) => void (await loginMachine(b.srv, b.owner, "laptop-1", allow("devtool"))) });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const requested: string[] = [];
  context.on("request", (r) => requested.push(r.url()));

  // When "devtool" posts "![](https://remote.example/p.png)"
  const devtool = await startSession(w.box, "devtool", "image");
  must(await agentPost(w.srv, devtool.lease, conv, "![](https://remote.example/p.png)", { format: "markdown" }), "post", 201);
  await openChat(page, w.srv, conv, "Ship search filters");

  // Then the owner sees a link to "remote.example"
  const link = message(page, "remote.example").getByRole("link", { name: /remote\.example/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://remote.example/p.png");
  await expect(message(page, "remote.example").locator("img")).toHaveCount(0);

  // And the browser request log has 0 requests to "remote.example"
  await page.waitForLoadState("networkidle");
  const hosts = requested.map((u) => new URL(u).hostname);
  expect(hosts.filter((h) => h === "remote.example")).toHaveLength(0);
  // (the log works: it holds the requests the page made to the server)
  expect(hosts).toContain("localhost");
});
