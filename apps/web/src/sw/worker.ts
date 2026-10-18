// The service worker (built to /sw.js). It installs every module file in this folder (each default-exports a SwModule).
// A new build's worker installs and then waits: it takes over only when the owner taps Reload (update.ts), so a page
// never runs half on old code and half on new. The first worker has nothing to wait for and takes over at once.
import type { SwModule } from "./module.ts";

declare const self: ServiceWorkerGlobalScope;

const modules = import.meta.glob<SwModule>(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"], { eager: true, import: "default" });
for (const mod of Object.values(modules)) mod.install(self);

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// The claim at activation misses a page whose navigation was still committing then (index.ts asks again for such a page).
self.addEventListener("message", (event) => {
  if (event.data?.type === "claim") event.waitUntil(self.clients.claim());
});
