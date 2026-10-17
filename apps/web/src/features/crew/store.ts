import type { AgentStatusChangedFrame } from "@convoz/api-client";
import type { CrewStatus } from "./types.ts";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

interface CrewState {
  /** The owner's view of every agent's status, by handle; null until the first load. */
  statuses: Record<string, CrewStatus> | null;
  load(): Promise<void>;
  /** A status frame: what changed is the state and its texts; the asks and the session are read again by the next load. */
  changed(frame: AgentStatusChangedFrame): void;
}

export const useCrew = create<CrewState>()((set) => ({
  statuses: null,
  load: async () => {
    const { statuses } = await call(client.GET("/api/status"));
    set({ statuses: Object.fromEntries(statuses.map((s) => [s.handle, s])) });
  },
  changed: (f) =>
    set((s) => {
      const had = s.statuses?.[f.handle];
      if (!s.statuses || !had) return s;
      const { prev_seq_for_you: _seq, ...rest } = f;
      return { statuses: { ...s.statuses, [f.handle]: { ...had, ...rest } } };
    }),
}));
