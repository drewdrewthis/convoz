import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { send } from "../lib/http.ts";
import { baseEnv, expect, run, scenario } from "../lib/scenario.ts";

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
