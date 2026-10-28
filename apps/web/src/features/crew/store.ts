import type { AgentStatusChangedFrame } from "@convoz/api-client";
import type { CrewStatus } from "./types.ts";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

interface CrewState {
  /** The owner's view of every agent's status, by handle; null until the first load. */
  statuses: Record<string, CrewStatus> | null;
  load(): Promise<void>;
  /** A status frame: what changed is the state and its texts; the asks and the session are read again by the next load. A turn to waiting or blocked is read from the server instead: the asks held here may be older than the ask behind it, and a guessed 0 would file the agent under "Waiting" for a moment. */
  changed(frame: AgentStatusChangedFrame): void;
}

export const useCrew = create<CrewState>()((set, get) => ({
  statuses: null,
  load: async () => {
    const { statuses } = await call(client.GET("/api/status"));
    set({ statuses: Object.fromEntries(statuses.map((s) => [s.handle, s])) });
  },
  changed: (f) =>
    set((s) => {
      const had = s.statuses?.[f.handle];
      if (!s.statuses || !had) return s;
      if (f.state !== had.state && (f.state === "waiting" || f.state === "blocked")) {
        void get().load().catch(() => {});
        return s;
      }
      const { prev_seq_for_you: _seq, ...rest } = f;
      return { statuses: { ...s.statuses, [f.handle]: { ...had, ...rest } } };
    }),
}));
