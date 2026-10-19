// Now: what waits for the owner (asks, adds to decide, machine requests), and the ask card a conversation shows.
import { registerHandler, registerResync } from "@convoz/api-client";
import { useNow } from "./store.ts";
import "./badge.ts";

export { Now } from "./Now.tsx";
export { AskInline } from "./AskInline.tsx";
export { useNow, openCount } from "./store.ts";
export { agentRequests, RequestCard, type AgentRequest } from "./requests.tsx";

// An ask changed (here or in another tab): the numbers follow at once, not at the next poll.
registerHandler("ask.", () => void useNow.getState().load().catch(() => {}));
// A plan changed (live, or read from the delta after a gap): an item may have started or stopped waiting on the owner.
registerHandler("plan.", () => void useNow.getState().load().catch(() => {}));
// The stream came back after a gap: an ask may have changed meanwhile.
registerResync(() => void useNow.getState().load().catch(() => {}));
