// The service worker (built to /sw.js). It installs every module file in this folder (each default-exports a SwModule).
// A new build's worker takes over by itself as soon as it has installed: an installed phone app that waits for a tap or a quiet
// moment can stay on an old build for days. The page reloads under the new worker (index.ts), so it never runs half on old code.
import type { SwModule } from "./module.ts";

declare const self: ServiceWorkerGlobalScope;

const modules = import.meta.glob<SwModule>(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"], { eager: true, import: "default" });
for (const mod of Object.values(modules)) mod.install(self);

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// The claim at activation misses a page whose navigation was still committing then (index.ts asks again for such a page).
self.addEventListener("message", (event) => {
  if (event.data?.type === "claim") event.waitUntil(self.clients.claim());
});
