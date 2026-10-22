import { useEffect } from "react";
import { nowCallLive } from "../features/call/index.ts";
import { navigate } from "../shared/navigate.ts";
import { route } from "./routes.tsx";

/**
 * useCallLinks keeps a Now call on across the app's links: pages are separate documents (App.tsx), and loading one would end the call,
 * so while one is on a plain click on a link to a page of the app draws that page in place (shared/navigate.ts). It listens after the
 * page's own handlers and leaves a click they took (Back's history.back) alone, as it does a click meant for a new tab or a download.
 */
export function useCallLinks(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!nowCallLive() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || route(url.pathname, undefined).name === "notfound") return;
      event.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
