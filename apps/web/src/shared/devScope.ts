// The owner's dev build of the web app lives at /dev/ on the same origin (the server's /dev route). The service worker of the real
// app has scope /, so it sees every request of a dev page: it must leave them all to the network, never answer one from the real
// app's cache. Only the worker imports this file (vite.config.ts lists it in OUTSIDE_MAIN).

/** inDevScope is true for /dev and every path under /dev/: the worker does not touch such a request. */
export function inDevScope(pathname: string): boolean {
  return pathname === "/dev" || pathname.startsWith("/dev/");
}
