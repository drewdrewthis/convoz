// The owner's deliveries (delivery.feature): one read of every deliverable. It follows the stream (a plan changed, or the stream came
// back after a gap) and reads again when time alone changes a state (next_change_at), as the plan board does.
import { registerHandler, registerResync, type Deliveries } from "@convoz/api-client";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

interface DeliveryState {
  data: Deliveries | null;
  /** The server's clock minus this page's, in ms: "late" and "in 2 h" are read against the server. */
  skew: number;
  load(): Promise<void>;
  /** ensure loads once for every reader of the page (the rail, Now, the page); the stream keeps it fresh after. */
  ensure(): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let asked = false;
const LONGEST_WAIT = 2 ** 31 - 1;

export const useDeliveries = create<DeliveryState>()((set, get) => ({
  data: null,
  skew: 0,
  load: async () => {
    const data = await call(client.GET("/api/deliveries"));
    set({ data, skew: data.now - Date.now() });
    clearTimeout(timer);
    if (data.next_change_at) {
      const wait = Math.min(LONGEST_WAIT, Math.max(250, data.next_change_at - data.now + 250));
      timer = setTimeout(() => void get().load().catch(() => {}), wait);
    }
  },
  ensure: () => {
    if (asked) return;
    asked = true;
    // Only the owner may read it: a member's refusal leaves the deliveries out, with no error on the page.
    void get().load().catch(() => (asked = false));
  },
}));

const reload = () => {
  if (useDeliveries.getState().data) void useDeliveries.getState().load().catch(() => {});
};
registerHandler("plan.", (frame) => {
  if (frame.name === "plan.changed") reload();
});
registerResync(reload);
