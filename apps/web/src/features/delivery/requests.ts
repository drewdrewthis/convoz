// "Request update" on the Deliveries page (owner msg 9982): the owner's message that asks an agent to update its plan, posted in the
// plan's conversation as the details panel's button does, so it reaches the agent's inbox as a mention. When it was sent lives in this
// page only (a reload forgets it): the button rests for HOLD after a request, and the row says whether the plan moved since.
import { create } from "zustand";
import { newId } from "../../shared/chat.ts";
import { source } from "../../shared/data.ts";
import { planRequest } from "../conversations/index.ts";
import { usePlans } from "../plan/index.ts";

/** How long the button rests after a request. */
export const HOLD = 10 * 60_000;

interface RequestState {
  /** When each plan (PlanRow.key) was last asked for an update, on the server's clock. */
  asked: Record<string, number>;
}

export const useRequests = create<RequestState>()(() => ({ asked: {} }));

/** serverNow is now on the server's clock, which the plans' update times use. */
export const serverNow = (): number => Date.now() + usePlans.getState().skew;

/** requestUpdate posts the ask in the conversation and notes when it was pressed, once the server took it. */
export async function requestUpdate(key: string, handle: string, conv: number): Promise<void> {
  const at = serverNow();
  await source.post(conv, newId(), planRequest(handle, conv, "update"));
  useRequests.setState((s) => ({ asked: { ...s.asked, [key]: at } }));
}
