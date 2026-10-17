import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { baseEnv, run } from "./run.ts";
import { repoRoot } from "./paths.ts";

/**
 * Helpers of the quality-gate bindings of WP18 (tests/quality-gates.wp18.spec.ts).
 * The UI story catalogue is Ladle over packages/ui (quality-gates AC-17): built to a scratch folder, then served on 127.0.0.1 so a
 * browser can open each story on its own (`?story=<id>&mode=preview`).
 */

const uiDir = path.join(repoRoot, "packages", "ui");

export interface Catalogue {
  /** Where the built catalogue is. */
  dir: string;
  /** Story ids from the catalogue's own meta.json, e.g. `field--plain`. */
  stories: string[];
}

/** `ladle build` of packages/ui into a scratch folder. Takes about 10 s. */
export async function buildCatalogue(): Promise<Catalogue> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-ladle-"));
  // Ladle joins the folder to its working directory, so it is given as a path relative to packages/ui.
  const res = await run(path.join(uiDir, "node_modules", ".bin", "ladle"), ["build", "--outDir", path.relative(uiDir, path.join(dir, "out"))], {
    cwd: uiDir,
    env: baseEnv({ CI: "1" }),
    timeoutMs: 90_000,
  });
  if (res.code !== 0) throw new Error(`ladle build failed (exit ${res.code})\n${res.stdout}\n${res.stderr}`);
  const out = path.join(dir, "out");
  const meta = JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8")) as { stories: Record<string, unknown> };
  return { dir: out, stories: Object.keys(meta.stories).sort() };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Serve a folder of static files on 127.0.0.1. */
export async function serveFolder(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^(\.\.[/\\])+/, ""));
    const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
    fs.readFile(target, (err, body) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream" }).end(body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** The source of axe-core, the version packages/ui pins. */
export function axeSource(): string {
  const need = createRequire(path.join(uiDir, "package.json"));
  return fs.readFileSync(need.resolve("axe-core/axe.min.js"), "utf8");
}
