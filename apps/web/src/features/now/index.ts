// Now: what waits for the owner (asks, adds to decide, machine requests), and the ask card a conversation shows.
import { registerHandler } from "@convoz/api-client";
import { useNow } from "./store.ts";
import "./badge.ts";

export { Now } from "./Now.tsx";
export { AskInline } from "./AskInline.tsx";
export { useNow, openCount } from "./store.ts";

// An ask changed (here or in another tab): the numbers follow at once, not at the next poll.
registerHandler("ask.", () => void useNow.getState().load().catch(() => {}));
