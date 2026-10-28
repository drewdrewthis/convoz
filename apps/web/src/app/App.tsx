import { Suspense, useEffect, useState, type ComponentType } from "react";
import { page } from "../shared/api.ts";
import { ToastHost } from "../features/pins-stars/index.ts";
import { Sidebar, ShortcutsHost, useRailShortcuts } from "../features/rail/index.ts";
import { SearchHost, useSearchShortcut } from "../features/search/index.ts";
import { useCallLinks } from "./callLinks.ts";
import { FocusFrame, ShellFrame } from "./frames.tsx";
import type { PageDef } from "./routes.tsx";
import { Status } from "./Status.tsx";
import { appPath, withBase } from "../shared/base.ts";

/** From this width the signed-in app is a sidebar rail and the page (prototype v41 desktop); under it, the phone UI. */
const DESK = "(min-width: 900px)";

/** The new-chat key is bound once, whichever page is drawn first or next. */
let newChatKey = false;

/**
 * prepare readies the document for a page before the first render: the body attributes the stylesheet keys on, the tab
 * title, whether a 401 sends the browser to sign in, and Cmd+J / Ctrl+J (a new chat from anywhere in the signed-in app),
 * so a key pressed as soon as the page has loaded is not lost. The wide-screen mark is set here too: set after the first
 * paint, the phone's Search button would show for a frame on a desktop.
 */
export function prepare(def: PageDef): void {
  const body = document.body.dataset;
  // The page before this one (a navigation inside the app) leaves none of its marks.
  delete body.public;
  delete body.shell;
  delete body.chat;
  body.page = def.name;
  if (def.public) body.public = "";
  if (def.frame === "shell") body.shell = "";
  if (def.frame === "chat") body.chat = "";
  document.title = `${def.title} - Convoz`;
  page.public = Boolean(def.public);
  if (def.frame === "focus") return;
  document.body.toggleAttribute("data-desk", matchMedia(DESK).matches);
  if (newChatKey) return;
  newChatKey = true;
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
      event.preventDefault();
      if (appPath() !== "/chats/new") location.assign(withBase("/chats/new"));
    }
  });
}

/** useDesk says whether the screen is wide enough for the sidebar, and marks the body so the stylesheet makes room for it. */
function useDesk(): boolean {
  const [wide, setWide] = useState(() => matchMedia(DESK).matches);
  useEffect(() => {
    const query = matchMedia(DESK);
    const on = () => setWide(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    document.body.toggleAttribute("data-desk", wide);
  }, [wide]);
  return wide;
}

/** Desk is what every signed-in page shares: the sidebar when wide, the keys no page owns, search, the toast, and the links that keep a Now call on. */
function Desk() {
  const wide = useDesk();
  useSearchShortcut();
  useRailShortcuts();
  useCallLinks();
  return (
    <>
      {wide ? (
        <Suspense fallback={null}>
          <Sidebar />
        </Suspense>
      ) : null}
      <SearchHost />
      <ShortcutsHost />
      <ToastHost />
    </>
  );
}

/** App frames the page of this URL. Navigation between pages is a full load: the server owns sign-in redirects and 404s. */
export function App({ def, Page }: { def: PageDef; Page: ComponentType }) {
  if (def.frame === "chat") {
    return (
      <>
        <Desk />
        <Page />
        <Status />
      </>
    );
  }
  const Frame = def.frame === "shell" ? ShellFrame : FocusFrame;
  return (
    <>
      {def.frame === "shell" ? <Desk /> : null}
      <Frame def={def}>
        <Page />
      </Frame>
      <Status />
    </>
  );
}
