import { createHash } from "node:crypto";
import path from "node:path";
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

// The build lands inside the Go console package, which embeds it (go:embed cannot reach outside its module).
// public/placeholder.txt is copied back after the folder is emptied, so the committed placeholder never shows as deleted.
export default defineConfig({
  plugins: [react(), tailwindcss(), precacheManifest()],
  build: {
    outDir: path.resolve(import.meta.dirname, "../convoz/internal/server/console/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    // The CSP allows our own scripts only; the polyfill is not needed by the browsers we serve.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The service worker is its own entry at a fixed URL (/sw.js): a worker's scope is the folder of its script.
      input: { main: path.resolve(import.meta.dirname, "index.html"), sw: path.resolve(import.meta.dirname, "src/sw/worker.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
});
