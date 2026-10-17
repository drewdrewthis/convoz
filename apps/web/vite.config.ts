import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build lands inside the Go console package, which embeds it (go:embed cannot reach outside its module).
// public/placeholder.txt is copied back after the folder is emptied, so the committed placeholder never shows as deleted.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
