// Paths of the app under a base folder. The real app is at the root (base ""); the owner's dev build is at /dev (base "/dev",
// `vite build --mode dev`), on the same server and with the same API and session. Screens and links name app paths ("/chats/12");
// the browser's address holds the based path ("/dev/chats/12"). These functions are pure, so they are tested without a page.

/** stripBase is the app path of a browser path: the path without the base. A path outside the base is returned as it is. */
export function stripBase(base: string, pathname: string): string {
  if (!base || (pathname !== base && !pathname.startsWith(`${base}/`))) return pathname;
  return pathname.slice(base.length) || "/";
}

/**
 * addBase is the browser URL of an app URL ("/chats/12?x=1#m3"): the base in front. A URL that is not a path of this site (another
 * origin, "//host", a relative one), an API path, or one already under the base is returned as it is.
 */
export function addBase(base: string, to: string): string {
  if (!base || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/api/")) return to;
  const path = to.split(/[?#]/, 1)[0]!;
  if (path === base || path.startsWith(`${base}/`)) return to;
  return base + to;
}
