// Now: what waits for the owner (asks, adds to decide, machine requests), and the ask card a conversation shows.
import { registerHandler, registerResync } from "@convoz/api-client";
import { useNow } from "./store.ts";
import "./badge.ts";

import { DEV } from "../../shared/base.ts";
import { DevNow } from "./DevNow.tsx";
import { Now as MainNow } from "./Now.tsx";

/** Now is the main app's list; the dev build (/dev) draws the one-list feed of DevNow instead. */
export const Now = DEV ? DevNow : MainNow;
export { AskInline } from "./AskInline.tsx";
export { useNow, openCount, needsYouCount, answerAsk, snoozeAsk } from "./store.ts";
export { agentRequests, RequestCard, type AgentRequest } from "./requests.tsx";

// An ask changed (here or in another tab): the numbers follow at once, not at the next poll.
registerHandler("ask.", () => void useNow.getState().load().catch(() => {}));
// A plan changed (live, or read from the delta after a gap): an item may have started or stopped waiting on the owner.
registerHandler("plan.", () => void useNow.getState().load().catch(() => {}));
// The stream came back after a gap: an ask may have changed meanwhile.
registerResync(() => void useNow.getState().load().catch(() => {}));
