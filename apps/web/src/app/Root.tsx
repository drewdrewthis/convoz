import { useEffect, useState, type ComponentType } from "react";
import { usePath } from "../shared/navigate.ts";
import { App, prepare } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { route, type PageDef } from "./routes.tsx";

interface Shown {
  path: string;
  def: PageDef;
  Page: ComponentType;
}

/**
 * Root draws the page of the open path. The first page comes loaded from the document; after that a path that moves without a
 * document load (shared/navigate.ts) is drawn here: the new page loads, then it replaces the old one, drawn from scratch.
 */
export function Root({ first }: { first: Shown }) {
  const path = usePath();
  const [shown, setShown] = useState(first);
  useEffect(() => {
    if (path === shown.path) return;
    let live = true;
    // The server's 404 mark belongs to the document it answered; a path the app navigates to is one it knows.
    const def = route(path, undefined);
    void def.load().then((Page) => {
      if (!live) return;
      prepare(def);
      setShown({ path, def, Page });
    });
    return () => {
      live = false;
    };
  }, [path, shown.path]);
  return (
    <ErrorBoundary>
      <App key={shown.path} def={shown.def} Page={shown.Page} />
    </ErrorBoundary>
  );
}
