// The owner's dev build only (main.tsx loads it when DEV). It keeps the browser under /dev/ and says which app is open:
//  - a fixed DEV badge on every screen, outside the app's root, so no page can drop it;
//  - every history entry the app writes gets the base (navigate, replaceState), so screens keep naming app paths;
//  - a link to an app path ("/crew") is given the base at the moment it is used (click, middle click, keyboard), so a full page
//    load stays in the dev build too. Links are drawn by many features; this one listener covers them all.
import "../styles/drawer.css";
import { withBase } from "./base.ts";

function based(url: string | URL | null | undefined): string | URL | null | undefined {
  return typeof url === "string" ? withBase(url) : url;
}

function wrapHistory(): void {
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (data, unused, url) => push(data, unused, based(url));
  history.replaceState = (data, unused, url) => replace(data, unused, based(url));
}

function baseLink(event: Event): void {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;
  const href = link.getAttribute("href") ?? "";
  const next = withBase(href);
  if (next !== href) link.setAttribute("href", next);
}

function badge(): void {
  const el = document.createElement("div");
  el.className = "dev-badge";
  el.textContent = "DEV";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "Dev build");
  document.body.append(el);
}

/** installDev sets up the dev build before the first screen draws. */
export function installDev(): void {
  wrapHistory();
  for (const type of ["click", "auxclick", "pointerdown", "keydown", "focusin", "contextmenu"]) document.addEventListener(type, baseLink, true);
  badge();
}
