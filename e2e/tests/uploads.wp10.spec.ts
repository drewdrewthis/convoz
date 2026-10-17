import fs from "node:fs";
import path from "node:path";
import { createConversation } from "../lib/chat.ts";
import { agentPostWith, leaseOf, msgWorld, ownerPurges, pageOf, type MsgWorld } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import type { ServerOptions } from "../lib/fixtures.ts";
import type { ServerHandle } from "../lib/fixtures.ts";
import {
  filesUnder, getFile, headUpload, html, ogg, peakRssKb, png, postWith, raw, sendChunk, setEngine, startUpload, svgFile, uploadWhole, wav, type Actor,
} from "../lib/uploads-wp10.ts";
import { searchAs } from "../lib/search-wp12.ts";

/*
 * UPLOADS, FILES AND VOICE (WP10), the API and CLI half: specs/contracts/composer.feature (an upload binds once, in its conversation,
 * when finished), specs/contracts/security.feature (safe inline types, pixel bomb, streamed cap, quota, avatars, moved blob) and
 * specs/contracts/voice.feature (audio headers, no plain audio on disk), and specs/features/voice.feature (a purge removes the
 * transcript). The routes are the contract block atop lib/uploads-wp10.ts.
 */

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; dataDir: string };

interface World extends MsgWorld {
  devtool: Actor;
  drew: Actor;
}

/** Background: a fresh server, owner "drew", machine "box-2" with "devtool", and "devtool" in conversation 41. */
async function world(fx: Fx): Promise<World> {
  const w = await msgWorld({ ...fx, participants: ["devtool"], agents: ["devtool", "docs"] });
  return { ...w, devtool: { srv: w.srv, lease: await leaseOf(w, "devtool") }, drew: { srv: w.srv, owner: w.owner } };
}

/** devtool uploads a file and posts it, so the owner may read it; returns the public id. */
async function sent(w: World, kind: string, name: string, bytes: Buffer): Promise<string> {
  const up = await uploadWhole(w.devtool, w.conv, kind, name, bytes);
  must(await postWith(w.devtool, w.conv, `here is ${name}`, [up.id]), `post ${name}`, 201);
  return up.id;
}

scenario("An upload binds to one message only", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given the owner uploaded "chart.png" and posted it in conversation 41
  const up = await uploadWhole(w.drew, w.conv, "image", "chart.png", png(8, 8, true));
  must(await postWith(w.drew, w.conv, "the chart", [up.id]), "first post", 201);

  // When a client posts another message with the same upload id
  const again = await postWith(w.drew, w.conv, "the chart again", [up.id]);

  // Then the server answers 409
  expect(again.status).toBe(409);
});

scenario("An upload cannot be used in another conversation", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });
  const conv52 = await createConversation(w.owner, { participants: ["devtool"], title: "Deploy alerts runbook" });

  // Given the owner uploaded "chart.png" for conversation 41
  const up = await uploadWhole(w.drew, w.conv, "image", "chart.png", png(8, 8, true));

  // When a client posts it in conversation 52
  const res = await postWith(w.drew, conv52, "wrong place", [up.id]);

  // Then the server answers 400
  expect(res.status).toBe(400);
  expect((await pageOf(w.owner, conv52)).length).toBe(0);
});

scenario("An unfinished upload cannot be posted", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given an upload of "big.zip" that is half done
  const bytes = Buffer.alloc(3_000_000, 7);
  const made = must(await startUpload(w.drew, w.conv, "file", "big.zip", bytes), "start", 201).json();
  const half = must(await sendChunk(w.drew, made.id, 0, bytes.subarray(0, 1_500_000)), "half").json();
  expect(half.state).toBe("receiving");

  // When a client posts a message with it
  const res = await postWith(w.drew, w.conv, "not yet", [made.id]);

  // Then the server answers 409
  expect(res.status).toBe(409);
  expect((await pageOf(w.owner, w.conv)).length).toBe(0);
});

scenario("Only safe images and audio are shown inline", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });
  const rows: [string, string, Buffer, string][] = [
    ["report.html", "file", html(), "attachment"],
    ["diagram.svg", "image", svgFile(), "attachment"],
    ["chart.png", "image", png(8, 8, true), "inline"],
    ["note.ogg", "audio", ogg(5000), "inline"],
    ["evil.png", "image", html(), "attachment"],
  ];
  for (const [name, kind, bytes, disposition] of rows) {
    // Given "devtool" uploaded <file>
    const id = await sent(w, kind, name, bytes);

    // When the owner fetches the file
    const res = await getFile(w.drew, id);

    // Then the response has Content-Disposition "<disposition>"
    expect(res.status, name).toBe(200);
    expect(String(res.headers["content-disposition"]), name).toMatch(new RegExp(`^${disposition}\\b`));
    // And it has "X-Content-Type-Options: nosniff" and a "sandbox; default-src 'none'" CSP
    expect(res.headers["x-content-type-options"], name).toBe("nosniff");
    expect(res.headers["content-security-policy"], name).toBe("sandbox; default-src 'none'");
    expect(res.body.equals(bytes), `${name} comes back byte for byte`).toBe(true);
  }
});

scenario("A pixel bomb is refused before decode", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });
  const before = peakRssKb(w.srv.pid);

  // When "devtool" uploads a 30000 by 30000 PNG
  const res = await uploadAttempt(w.devtool, w.conv, "image", "bomb.png", png(30000, 30000));

  // Then the server refuses it with "image too large"
  expect(res.status).toBe(413);
  expect(res.text).toContain("image too large");
  // And the server's memory stays under its limit
  expect(peakRssKb(w.srv.pid) - before).toBeLessThan(200 * 1024);
  expect(peakRssKb(w.srv.pid)).toBeLessThan(1024 * 1024);
});

/** Start an upload and send every byte; returns the answer of the last request. */
async function uploadAttempt(who: Actor, conv: number, kind: string, name: string, bytes: Buffer) {
  const made = must(await startUpload(who, conv, kind, name, bytes), "start", 201).json();
  return sendChunk(who, made.id, 0, bytes);
}

scenario("The size cap applies to the bytes streamed", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // When "devtool" streams more bytes than the size it declared
  const declared = Buffer.alloc(1000, 1);
  const made = must(await raw(w.devtool, "POST", "/api/uploads", { json: { conversation_id: w.conv, kind: "file", filename: "liar.bin", size: 1000, sha256: "0".repeat(64) } }), "start", 201).json();
  const res = await sendChunk(w.devtool, made.id, 0, Buffer.alloc(100_000, 9));

  // Then the server stops the upload at the cap and answers 413
  expect(res.status).toBe(413);
  expect((await headUpload(w.devtool, made.id)).status).toBe(404);
  const stored = filesUnder(path.join(dataDir, "blobs")).map((f) => f.bytes.length);
  expect(stored.every((n) => n <= declared.length + 64)).toBe(true);
});

scenario("Uploads have a daily byte quota per identity", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given "devtool" uploaded 500 MB today: 20 uploads of the 25 MB cap
  for (let i = 0; i < 20; i++) {
    const res = await raw(w.devtool, "POST", "/api/uploads", { json: { conversation_id: w.conv, kind: "file", filename: `big-${i}.bin`, size: 26214400, sha256: "1".repeat(64) } });
    expect(res.status, `upload ${i}`).toBe(201);
  }

  // When it starts another upload
  const next = await raw(w.devtool, "POST", "/api/uploads", { json: { conversation_id: w.conv, kind: "file", filename: "one-more.bin", size: 10, sha256: "2".repeat(64) } });

  // Then the server answers 429
  expect(next.status).toBe(429);
  // and another identity is not held up
  const owners = await raw(w.drew, "POST", "/api/uploads", { json: { conversation_id: w.conv, kind: "file", filename: "mine.bin", size: 10, sha256: "2".repeat(64) } });
  expect(owners.status).toBe(201);
});

scenario("Avatar SVGs are cleaned and fenced", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });
  const list = must(await w.owner.client.get("/api/identities"), "identities").json().identities as { id: number; handle: string }[];
  const id = list.find((p) => p.handle === "devtool")!.id;
  const shapes = '<circle cx="5" cy="5" r="4" fill="#c33"/><rect x="1" y="1" width="3" height="3"/>';
  const set = (svg: string) => raw(w.devtool, "PATCH", "/api/me/profile", { json: { avatar_svg: svg } });
  const served = () => raw(w.drew, "GET", `/api/identities/${id}/avatar.svg`);

  // When "devtool" sets an avatar SVG that holds a script element
  expect((await set(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script>${shapes}</svg>`)).status).toBe(200);
  // Then the served avatar has no script element
  const scripted = await served();
  expect(scripted.status).toBe(200);
  expect(scripted.text).not.toContain("script");
  expect(scripted.text).toContain("<circle");

  // When it holds a DOCTYPE, Then the server answers 400
  expect((await set(`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`)).status).toBe(400);
  // When it holds an ENTITY declaration, Then the server answers 400
  expect((await set(`<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><text>&a;</text></svg>`)).status).toBe(400);

  // When it is plain shapes, Then the avatar is served with "default-src 'none'; sandbox" and nosniff
  expect((await set(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${shapes}</svg>`)).status).toBe(200);
  const plain = await served();
  expect(plain.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(plain.headers["x-content-type-options"]).toBe("nosniff");
  expect(plain.headers["content-type"]).toContain("image/svg+xml");
});

scenario("A blob moved to another file id cannot be read", { tag: ["@api", "@invariant"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given two uploaded files on disk (the same size, so only the seal can tell them apart)
  const a = Buffer.alloc(4000, "A");
  const b = Buffer.alloc(4000, "B");
  const idA = await sent(w, "file", "a.bin", a);
  const idB = await sent(w, "file", "b.bin", b);
  expect((await getFile(w.drew, idA)).body.equals(a)).toBe(true);
  const blobs = path.join(dataDir, "blobs");
  const names = fs.readdirSync(blobs).sort();
  expect(names.length).toBe(2);

  // When the test swaps their encrypted blob files
  const tmp = path.join(blobs, "swap.tmp");
  fs.renameSync(path.join(blobs, names[0]!), tmp);
  fs.renameSync(path.join(blobs, names[1]!), path.join(blobs, names[0]!));
  fs.renameSync(tmp, path.join(blobs, names[1]!));

  // Then fetching either file answers an error and returns no bytes
  for (const id of [idA, idB]) {
    const res = await getFile(w.drew, id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.includes(Buffer.from("AAAA"))).toBe(false);
    expect(res.body.includes(Buffer.from("BBBB"))).toBe(false);
  }
});

scenario("Audio is served inline with safe headers", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given the owner sent a voice note
  const up = await uploadWhole(w.drew, w.conv, "audio", "voice-note.wav", wav(2));
  must(await postWith(w.drew, w.conv, "", [up.id]), "voice message", 201);

  // When a client fetches its file
  const res = await getFile(w.drew, up.id);

  // Then it is served inline with "nosniff" and the sandbox CSP
  expect(res.status).toBe(200);
  expect(String(res.headers["content-disposition"])).toMatch(/^inline\b/);
  expect(res.headers["content-type"]).toBe("audio/wav");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  // and a range request plays from the middle
  const part = await getFile(w.drew, up.id, { Range: "bytes=100-199" });
  expect(part.status).toBe(206);
  expect(part.body.length).toBe(100);
});

scenario("No plain audio touches the disk while uploading", { tag: ["@cli", "@invariant"] }, async ({ server, dataDir }) => {
  // Background (the encrypted build: no plain data file)
  const w = await msgWorld({ server, dataDir, participants: ["devtool"], agents: ["devtool"], env: { CONVOZ_TEST_PLAINTEXT: "" } });
  const drew: Actor = { srv: w.srv, owner: w.owner };

  // Given the server runs with a data dir the test can scan
  const marker = Buffer.alloc(64, "ZQXAUDIOFIXTURE0");
  const fixture = ogg(2_600_000, marker);
  const scan = (): number => filesUnder(dataDir).filter((f) => f.bytes.includes(marker)).length;

  // When the owner records and sends a voice note with a known audio fixture (sent here in three chunks)
  const made = must(await startUpload(drew, w.conv, "audio", "voice-note.ogg", fixture), "start", 201).json();
  must(await sendChunk(drew, made.id, 0, fixture.subarray(0, 1_300_000)), "first");
  // Then a scan of the data dir during ...
  expect(fs.readdirSync(path.join(dataDir, "blobs")).length).toBe(1); // a sealed segment is on disk, so the scan means something
  expect(scan()).toBe(0);
  must(await sendChunk(drew, made.id, 1_300_000, fixture.subarray(1_300_000)), "rest");
  must(await postWith(drew, w.conv, "", [made.id]), "voice message", 201);
  // ... and after the upload finds no run of the fixture's bytes
  expect(scan()).toBe(0);
  expect((await getFile(drew, made.id)).body.includes(marker)).toBe(true); // while the server can still read it back
});

scenario("Purging a voice note removes its transcript", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await world({ server, dataDir });

  // Given a voice note whose transcript says "ZQX-voice-secret"
  await setEngine(w, "fake", "the code is ZQX-voice-secret");
  const up = await uploadWhole(w.drew, w.conv, "audio", "voice-note.wav", wav(2));
  const id = must(await postWith(w.drew, w.conv, "", [up.id]), "voice message", 201).json().id as number;
  await expect.poll(async () => (await pageOf(w.owner, w.conv)).at(-1)?.uploads?.[0]?.transcript?.state, { timeout: 15_000 }).toBe("done");
  expect((await searchAs(w, "ZQX-voice-secret")).results.map((r) => r.message_id)).toContain(id);

  // When the owner purges the message with a passkey
  must(await ownerPurges(w.owner, id), "purge");

  // Then search for "ZQX-voice-secret" returns nothing
  expect((await searchAs(w, "ZQX-voice-secret")).results).toEqual([]);
  // And the voice note no longer plays for anyone
  expect((await getFile(w.drew, up.id)).status).toBe(404);
  expect((await getFile(w.devtool, up.id)).status).toBe(404);
  expect(fs.readdirSync(path.join(dataDir, "blobs"))).toEqual([]);
});
