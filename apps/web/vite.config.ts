import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Files the app shell needs that Vite does not emit (they keep their names; the server serves them). The shell page itself is
// the one document every page URL answers with, fetched from the public /signin so the install needs no session.
const FIXED_FILES = ["/manifest.webmanifest", "/favicon.ico", "/apple-touch-icon.png", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/lookalikes.js", "/assets/settings/theme-boot.js"];
const SHELL_URL = "/signin?shell=1";

/**
 * The list the service worker precaches (Workbox injectManifest): every hashed file of the build (revision null, the name is the
 * version), the fixed files and the shell page (both revised by a hash of the build). It replaces `self.__WB_MANIFEST` in sw.js.
 */
function precacheManifest(): Plugin {
  return {
    name: "precache-manifest",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const worker = bundle["sw.js"];
      if (!worker || worker.type !== "chunk") return;
      const hashed = Object.keys(bundle).filter((name) => name.startsWith("assets/") && name !== "sw.js");
      const html = bundle["index.html"];
      const build = createHash("sha256").update(hashed.join()).update(html && html.type === "asset" ? html.source : "").digest("hex").slice(0, 16);
      const list = [
        ...hashed.map((name) => ({ url: `/${name}`, revision: null })),
        ...[...FIXED_FILES, SHELL_URL].map((url) => ({ url, revision: build })),
      ];
      worker.code = worker.code.replace("self.__WB_MANIFEST", JSON.stringify(list));
    },
  };
}

/**
 * The chunks each first screen needs beyond the main bundle, by URL (src/early.ts reads the list): the feature index (and, for a
 * conversation, its pages module) that the route loads. "/chats/:id" stands for every conversation URL.
 */
const FIRST_SCREENS: Record<string, string[]> = {
  "/": ["src/features/now/index.ts"],
  "/chats": ["src/features/conversations/index.ts"],
  "/chats/:id": ["src/features/conversations/index.ts", "src/features/conversations/pages.ts"],
};

/**
 * earlyScript puts the head-start script (src/early.ts, its own entry with no imports) first in the shell page, async so it runs
 * the moment it arrives, with the list of each first screen's chunks in <meta name="convoz-pages">. Chunks the shell already
 * loads (the main bundle and what it imports) are left out. It runs before precacheManifest, which hashes the final page.
 */
function earlyScript(): Plugin {
  return {
    name: "early-script",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const html = bundle["index.html"];
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const early = chunks.find((c) => c.name === "early" && c.isEntry);
      if (!html || html.type !== "asset" || !early) return;
      const main = chunks.find((c) => c.name === "main" && c.isEntry);
      const loaded = new Set<string>(main ? [main.fileName, ...main.imports] : []);
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const withImports = (file: string, out: Set<string>) => {
        if (out.has(file) || loaded.has(file)) return;
        out.add(file);
        for (const dep of byFile.get(file)?.imports ?? []) withImports(dep, out);
      };
      const pages: Record<string, string[]> = {};
      for (const [url, modules] of Object.entries(FIRST_SCREENS)) {
        const files = new Set<string>();
        for (const m of modules) {
          const id = path.resolve(import.meta.dirname, m);
          const chunk = chunks.find((c) => c.moduleIds.includes(id));
          if (!chunk) throw new Error(`early-script: no chunk holds ${m}`);
          withImports(chunk.fileName, files);
        }
        pages[url] = [...files].map((f) => `/${f}`);
      }
      const meta = JSON.stringify(pages).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const tags = `<meta name="convoz-pages" content="${meta}">\n<script type="module" async crossorigin src="/${early.fileName}"></script>\n`;
      const source = String(html.source);
      const at = source.indexOf("<script");
      if (at < 0) throw new Error("early-script: the shell page has no script");
      html.source = source.slice(0, at) + tags + source.slice(at);
    },
  };
}

/**
 * precompress writes a brotli copy (<file>.br, highest quality) of every script and stylesheet of assets/, which the server sends
 * to a client that takes brotli (design §12.3): on a slow link the first load is bound by these bytes, and compressing per request
 * runs at a low quality. It works on the files as written (later hooks still edit chunks), so the service worker never lists them.
 */
function precompress(): Plugin {
  return {
    name: "precompress",
    apply: "build",
    writeBundle(options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!file.fileName.startsWith("assets/") || !/\.(js|css)$/.test(file.fileName)) continue;
        const written = path.join(options.dir!, file.fileName);
        const packed = brotliCompressSync(readFileSync(written), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } });
        writeFileSync(`${written}.br`, packed);
      }
    },
  };
}

// The build lands inside the Go console package, which embeds it (go:embed cannot reach outside its module).
// public/placeholder.txt is copied back after the folder is emptied, so the committed placeholder never shows as deleted.
export default defineConfig({
  plugins: [react(), tailwindcss(), earlyScript(), precacheManifest(), precompress()],
  build: {
    outDir: path.resolve(import.meta.dirname, "../convoz/internal/server/console/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    // The CSP allows our own scripts only; the polyfill is not needed by the browsers we serve.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The service worker is its own entry at a fixed URL (/sw.js): a worker's scope is the folder of its script.
      // early.ts is an entry of its own so it imports nothing and runs before the main bundle has arrived (earlyScript).
      input: { main: path.resolve(import.meta.dirname, "index.html"), early: path.resolve(import.meta.dirname, "src/early.ts"), sw: path.resolve(import.meta.dirname, "src/sw/worker.ts") },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
        // The code every page shares (React, the stores, the API client, the shared data cache) is one chunk: left alone, the
        // bundler cuts it into several small ones, and on an HTTP/1.1 link (6 connections) each extra file of the first load
        // waits a round trip for a free connection.
        codeSplitting: { groups: [{ name: "core", test: /node_modules[\\/](react|scheduler|zustand|openapi-fetch|idb)[\\/]|packages[\\/]api-client[\\/]src|apps[\\/]web[\\/]src[\\/]shared[\\/](api|data|offline|connection|chat|early|perf)\.ts/ }] },
      },
    },
  },
});
