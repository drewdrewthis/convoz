import type { ComponentType } from "react";
import { page } from "../shared/api.ts";
import { FocusFrame, ShellFrame } from "./frames.tsx";
import type { PageDef } from "./routes.tsx";
import { Status } from "./Status.tsx";

/**
 * prepare readies the document for a page before the first render: the body attributes the stylesheet keys on, the tab
 * title, whether a 401 sends the browser to sign in, and Cmd+J / Ctrl+J (a new chat from anywhere in the signed-in app),
 * so a key pressed as soon as the page has loaded is not lost.
 */
export function prepare(def: PageDef): void {
  const body = document.body.dataset;
  body.page = def.name;
  if (def.public) body.public = "";
  if (def.frame === "shell") body.shell = "";
  if (def.frame === "chat") body.chat = "";
  document.title = `${def.title} - Convoz`;
  page.public = Boolean(def.public);
  if (def.frame === "focus") return;
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
      event.preventDefault();
      if (location.pathname !== "/chats/new") location.assign("/chats/new");
    }
  });
}

/** App frames the page of this URL. Navigation between pages is a full load: the server owns sign-in redirects and 404s. */
export function App({ def, Page }: { def: PageDef; Page: ComponentType }) {
  const Frame = def.frame === "shell" ? ShellFrame : FocusFrame;
  return (
    <>
      {def.frame === "chat" ? (
        <Page />
      ) : (
        <Frame def={def}>
          <Page />
        </Frame>
      )}
      <Status />
    </>
  );
}
