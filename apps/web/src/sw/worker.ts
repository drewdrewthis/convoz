// The service worker (built to /sw.js). It installs every module file in this folder (each default-exports a SwModule)
// and takes over at once, so a new build's worker serves the next load.
import type { SwModule } from "./module.ts";

declare const self: ServiceWorkerGlobalScope;

const modules = import.meta.glob<SwModule>(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"], { eager: true, import: "default" });
for (const mod of Object.values(modules)) mod.install(self);

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
