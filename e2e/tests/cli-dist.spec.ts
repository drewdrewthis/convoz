import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { agentPort, agentServer } from "../lib/agent-port.ts";
import { chatWorld } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { baseEnv, convozBin, expect, run, scenario } from "../lib/scenario.ts";

/** The binary the installer picks on this machine: convoz-<os>-<arch>. */
const cliName = `convoz-${os.platform()}-${os.arch() === "x64" ? "amd64" : os.arch()}`;
const scratch = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A server of our own that answers every path with `answer`; the test closes it. */
async function fakeServer(answer: (url: string) => { status?: number; body: Buffer | string }) {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const a = answer(req.url ?? "");
    res.writeHead(a.status ?? 200, { "content-type": "application/octet-stream" }).end(a.body);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

scenario("An agent installs the CLI from the server", { tag: ["@cli"] }, async ({ server }) => {
  // Given a machine with no convoz installed and an empty home folder, and a server
  const srv = await server({ host: "localhost" });
  const home = scratch("convoz-home-");
  const version = (await send(srv.target, "GET", "/api/version")).json().version as string;

  // When the agent runs the install script from the server
  const script = await send(srv.target, "GET", "/install");
  expect(script.status).toBe(200);
  const file = path.join(scratch("convoz-install-"), "install.sh");
  fs.writeFileSync(file, script.text);
  const install = await run("sh", [file], { env: baseEnv({ HOME: home }), timeoutMs: 60_000 });

  // Then convoz is installed in the home folder's ".local/bin"
  expect(install.code, install.stderr).toBe(0);
  const installed = path.join(home, ".local", "bin", "convoz");
  expect(fs.statSync(installed).mode & 0o111).not.toBe(0);

  // And "convoz version" prints the version of the server
  const ver = await run(installed, ["version"], { env: baseEnv({ HOME: home }) });
  expect(ver.stdout.startsWith(`convoz ${version} commit `)).toBe(true);
  expect(install.stdout).toContain(`convoz ${version} commit`);

  // And the installer says how to put it on the PATH, and never asks for root
  expect(install.stdout).toContain(`export PATH="${path.join(home, ".local", "bin")}:$PATH"`);
  expect(script.text).not.toMatch(/\bsudo\b/);
});

scenario("An agent outside the tailnet installs the CLI through the agent address", { tag: ["@cli"] }, async ({ server }) => {
  // Given a machine with no convoz installed and an empty home folder, and a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const home = scratch("convoz-home-");

  // When the agent runs the install script it got from the agents-only address
  const script = await send(agent.target, "GET", "/install");
  expect(script.status).toBe(200);
  const file = path.join(scratch("convoz-install-"), "install.sh");
  fs.writeFileSync(file, script.text);
  const install = await run("sh", [file], { env: baseEnv({ HOME: home }), timeoutMs: 60_000 });

  // Then convoz is installed in the ".local/bin" folder of the home folder
  expect(install.code, install.stderr).toBe(0);
  expect(fs.statSync(path.join(home, ".local", "bin", "convoz")).mode & 0o111).not.toBe(0);

  // And the script downloads the CLI from the agents-only address and not from the owner's address
  expect(script.text).toContain(`SERVER='${agent.origin}'`);
  expect(script.text).not.toContain(`SERVER='${srv.origin}'`);
});

scenario("The installer also installs the man page", { tag: ["@cli"] }, async ({ server }) => {
  // Given a machine with no convoz installed and an empty home folder, and a server
  const srv = await server({ host: "localhost" });
  const home = scratch("convoz-home-");

  // When the agent runs the install script of the server
  const file = path.join(scratch("convoz-install-"), "install.sh");
  fs.writeFileSync(file, (await send(srv.target, "GET", "/install")).text);
  const install = await run("sh", [file], { env: baseEnv({ HOME: home }), timeoutMs: 60_000 });
  expect(install.code, install.stderr).toBe(0);

  // Then "convoz.1" is installed in the ".local/share/man/man1" folder of the home folder
  const manDir = path.join(home, ".local", "share", "man");
  const page = fs.readFileSync(path.join(manDir, "man1", "convoz.1"), "utf8");
  expect(page).toMatch(/^\.TH CONVOZ 1/m);

  // And "man convoz" shows it when that man folder is on the man path
  const shown = await run("man", ["convoz"], { env: baseEnv({ HOME: home, MANPATH: manDir, MANPAGER: "cat", MANWIDTH: "200" }), timeoutMs: 20_000 });
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.stdout).toContain("NAME");
});

scenario("The installer refuses a binary whose checksum does not match", { tag: ["@cli"] }, async ({ server }) => {
  // Given a server whose SHA256SUMS does not match the binary it serves
  const srv = await server({ host: "localhost" });
  const script = (await send(srv.target, "GET", "/install")).text;
  const fake = await fakeServer((url) =>
    url.startsWith("/cli/SHA256SUMS") ? { body: `${"0".repeat(64)}  ${cliName}\n` } : { body: "#!/bin/sh\necho not the real convoz\n" },
  );
  try {
    const home = scratch("convoz-home-");
    const file = path.join(scratch("convoz-install-"), "install.sh");
    fs.writeFileSync(file, script.replace(/^SERVER='.*'$/m, `SERVER='${fake.origin}'`));

    // When the install script runs
    const install = await run("sh", [file], { env: baseEnv({ HOME: home }), timeoutMs: 60_000 });

    // Then it exits non-zero, names the checksum, and installs nothing: no convoz and no leftover download
    expect(fake.hits.some((h) => h.startsWith(`/cli/${cliName}`))).toBe(true);
    expect(install.code).toBe(1);
    expect(install.stderr).toContain("checksum mismatch");
    expect(fs.readdirSync(path.join(home, ".local", "bin"))).toEqual([]);
  } finally {
    await fake.close();
  }
});

scenario("The server serves its CLI with cache headers fixed by version", { tag: ["@api"] }, async ({ server }) => {
  // Given a server and its version
  const srv = await server({ host: "localhost" });
  const version = (await send(srv.target, "GET", "/api/version")).json().version as string;

  // When each CLI file is asked for with no credential, by HEAD so the body is not pulled
  const versioned = await send(srv.target, "HEAD", `/cli/${cliName}?v=${encodeURIComponent(version)}`);
  const plain = await send(srv.target, "HEAD", `/cli/${cliName}`);
  const sums = await send(srv.target, "GET", "/cli/SHA256SUMS");
  const unknown = await send(srv.target, "GET", "/cli/convoz-plan9-mips");

  // Then a request naming the server's version is immutable and one without it is revalidated by its ETag
  expect(versioned.status).toBe(200);
  expect(versioned.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(plain.headers["cache-control"]).toBe("no-cache");
  expect(plain.headers.etag).toBe(versioned.headers.etag);

  // And SHA256SUMS lists a sha256 line for each platform, with the digest the ETag of that binary names
  const line = sums.text.split("\n").find((l) => l.endsWith(`  ${cliName}`));
  expect(sums.text.split("\n").filter(Boolean)).toHaveLength(4);
  expect(`"${line?.split("  ")[0]}"`).toBe(versioned.headers.etag);

  // And a file the server does not have is a 404
  expect(unknown.status).toBe(404);
});

scenario("Login warns when the CLI and the server differ in version", { tag: ["@cli"] }, async ({ convoz }) => {
  // Given a server that reports another version than this CLI
  const fake = await fakeServer((url) => (url === "/api/version" ? { body: JSON.stringify({ version: "other-0" }) } : { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no" } }) }));
  try {
    // When "convoz login" runs against it
    const login = await convoz(["login", "--server", fake.origin, "--name", "box-2"], { env: { HOME: scratch("convoz-home-") } });

    // Then it warns on stderr how to update, with the install line of that server
    expect(login.stderr).toContain(`update: curl -fsSL ${fake.origin}/install | sh`);
  } finally {
    await fake.close();
  }
});

/** A testhooks build reads this as its own version: the way a scenario makes "a convoz older than the server". */
const OLD = "0.0.1-old";

/** The binary under test, copied to a folder of its own: `convoz upgrade` replaces the copy and never the real file. */
function copyOfConvoz(): string {
  const file = path.join(scratch("convoz-bin-"), "convoz");
  fs.copyFileSync(convozBin, file);
  fs.chmodSync(file, 0o755);
  return file;
}

scenario("A CLI older than its server runs and warns at most once an hour", { tag: ["@cli"] }, async ({ server }) => {
  // Given a machine logged in to a server, with a convoz older than that server and the same API number
  const w = await chatWorld(server, { agents: ["devtool"] });
  const current = (await send(w.srv.target, "GET", "/api/version")).json().version as string;
  const old = { env: { CONVOZ_TEST_VERSION: OLD } };

  // When the agent runs "convoz inbox --peek"
  const first = await w.box.run(["inbox", "--peek", "--as", "devtool"], old);

  // Then the command runs and exits 0, and stderr has one line telling it to upgrade
  const message = `convoz: the server runs ${current}, you have ${OLD}. Still works; run: convoz upgrade\n`;
  expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: message });

  // And running it again within an hour prints no such line
  const second = await w.box.run(["inbox", "--peek", "--as", "devtool"], old);
  expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });

  // And "convoz help", "convoz version" and "convoz whoami" still run
  for (const argv of [["help"], ["version"], ["whoami"]]) {
    const ok = await w.box.run(argv, old);
    expect({ argv, code: ok.code, stderr: ok.stderr }).toEqual({ argv, code: 0, stderr: "" });
  }

  // And a convoz of the same version as the server runs the command
  const same = await w.box.run(["inbox", "--peek", "--as", "devtool"]);
  expect({ code: same.code, stderr: same.stderr }).toEqual({ code: 0, stderr: "" });
});

scenario("convoz upgrade replaces the binary and the skill", { tag: ["@cli"] }, async ({ server }) => {
  // Given a machine logged in to a server, with a convoz older than that server and a stale skill file
  const w = await chatWorld(server, { agents: ["devtool"] });
  const current = (await send(w.srv.target, "GET", "/api/version")).json().version as string;
  const bin = copyOfConvoz();
  const skill = path.join(w.box.home, ".claude", "skills", "convoz", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: convoz\n---\nA stale skill.\n");

  // When the agent runs "convoz upgrade"
  const up = await run(bin, ["upgrade"], { env: w.box.env({ env: { CONVOZ_TEST_VERSION: OLD } }), timeoutMs: 60_000 });

  // Then it prints "Upgraded convoz <old> → <new>"
  expect(up.code, up.stderr).toBe(0);
  expect(up.stdout).toContain(`Upgraded convoz ${OLD} → ${current}`);

  // And "convoz version" now prints the version of the server
  const ver = await run(bin, ["version"], { env: w.box.env() });
  expect(ver.stdout.startsWith(`convoz ${current} commit `)).toBe(true);

  // And the skill file is the one of the new convoz
  const fresh = await run(bin, ["skill"], { env: w.box.env() });
  expect(fs.readFileSync(skill, "utf8")).toBe(fresh.stdout);

  // And no temporary file is left next to the binary
  expect(fs.readdirSync(path.dirname(bin))).toEqual(["convoz"]);
});
