// The plans the owner sees: one board for the Conversations list (every conversation) and one per open conversation. Both follow the
// stream ("plan.changed", a system line, a status or an ask) and read again when time alone changes a line (next_change_at).
import { registerHandler, registerResync, type PlanBoard } from "@convoz/api-client";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

/** The key of the list's board; a conversation's board is under its id. */
export const ALL = 0;

interface PlanState {
  boards: Record<number, PlanBoard>;
  /** The server's clock minus this page's, in ms: lateness and "ago" are read against the server. */
  skew: number;
  load(conv: number): Promise<void>;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const LONGEST_WAIT = 2 ** 31 - 1;

export const usePlans = create<PlanState>()((set, get) => ({
  boards: {},
  skew: 0,
  load: async (conv) => {
    const board = await call(client.GET("/api/plans", { params: { query: conv === ALL ? {} : { conversation: conv } } }));
    const skew = board.now - Date.now();
    set((s) => ({ skew, boards: { ...s.boards, [conv]: board } }));
    clearTimeout(timers.get(conv));
    if (board.next_change_at) {
      const wait = Math.min(LONGEST_WAIT, Math.max(250, board.next_change_at - board.now + 250));
      timers.set(conv, setTimeout(() => void get().load(conv).catch(() => {}), wait));
    }
  },
}));

/** reload reads again the boards held for the conversation (0: every held board). */
function reload(conv: number): void {
  const { boards, load } = usePlans.getState();
  for (const key of Object.keys(boards).map(Number)) {
    if (conv === 0 || key === ALL || key === conv) void load(key).catch(() => {});
  }
}

registerHandler("plan.", (frame) => {
  if (frame.name === "plan.changed") reload(frame.data.conversation_id);
});
registerHandler("message.", (frame) => {
  // A line the conversation says about itself may be an agent that stopped responding.
  if (frame.name === "message.created" && frame.data.author.kind === "system") reload(frame.data.conversation_id);
});
registerHandler("agent.", (frame) => {
  if (frame.name === "agent.status_changed") reload(0);
});
registerHandler("ask.", () => reload(0));
registerResync(() => reload(0));
