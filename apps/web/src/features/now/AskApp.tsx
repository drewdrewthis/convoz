import type { Ask } from "@convoz/api-client";
import { lazy, Suspense } from "react";

// The apps host (its kits, its frame bridge and the schemas it validates with) is a chunk of its own: the ask card is in the main
// bundle with Now, and only an ask that carries an app needs the host.
const AppHost = lazy(() => import("../apps-host/index.ts").then((f) => ({ default: f.AppHost })));

/** AskApp is the app an agent attached to an ask, shown under the card in Now and in a conversation alike. Nothing when there is none. */
export function AskApp({ ask }: { ask: Ask }) {
  if (!ask.app) return null;
  return (
    <Suspense fallback={null}>
      <AppHost app={ask.app} messageId={ask.id} agent={ask.asker} conversation={ask.conversation_id} threadRoot={ask.thread_root_id} onAsk />
    </Suspense>
  );
}
