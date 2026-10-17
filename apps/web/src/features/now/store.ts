// Now's state: what waits for the owner (asks, adds agents wait on, machines waiting to connect). The tab bar and the top bar
// read it on every signed-in page, so the store polls on its own; a stream frame about an ask loads it at once.
import type { Ask, MachineRequest, Now } from "@convoz/api-client";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

interface NowState {
  now: Now | null;
  /** The server's clock minus this page's clock, in ms: "Tonight" and "snoozed until" are read against the server's time. */
  skew: number;
  machineRequests: MachineRequest[] | null;
  load(): Promise<Now>;
  loadMachineRequests(): Promise<MachineRequest[]>;
  /** Poll while someone needs the numbers. Returns the stop. */
  start(): () => void;
}

const DEFAULT_POLL = 5000;
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useNow = create<NowState>()((set, get) => {
  const tick = () => {
    clearTimeout(timer);
    if (!watchers) return;
    get()
      .load()
      .catch(() => {})
      .finally(() => {
        if (watchers) timer = setTimeout(tick, Math.max(200, get().now?.poll_ms ?? DEFAULT_POLL));
      });
  };
  return {
    now: null,
    skew: 0,
    machineRequests: null,
    load: async () => {
      const now = await call(client.GET("/api/now"));
      set({ now, skew: now.now - Date.now(), machineRequests: now.machine_requests });
      return now;
    },
    loadMachineRequests: async () => (await get().load()).machine_requests,
    start: () => {
      if (!watchers++) tick();
      return () => {
        if (!--watchers) clearTimeout(timer);
      };
    },
  };
});

/** openCount is how many things wait: asks that are not snoozed, adds to decide and machines to approve. null before the first load. */
export function openCount(now: Now | null): number | null {
  return now ? now.asks.length + now.pending_adds.length + now.machine_requests.length : null;
}

/** The newest state of an ask after an action, or the ask that won when the action lost the race (409). */
export interface Settled {
  ask: Ask;
  /** true when another change came first: `ask` is how it stands now. */
  lost: boolean;
}

async function settle(request: Promise<{ data?: { ask: Ask }; error?: unknown; response: Response }>): Promise<Settled> {
  const { data, error, response } = await request;
  if (response.ok && data) return { ask: data.ask, lost: false };
  const won = (error as { ask?: Ask } | undefined)?.ask;
  if (response.status === 409 && won) return { ask: won, lost: true };
  await call(Promise.resolve({ error, response }));
  throw new Error("unreachable");
}

const params = (id: number) => ({ params: { path: { id } } });

export const answerAsk = (id: number, body: { choice: "recommended" | "alternative" | "custom"; index?: number; text?: string; if_version: number; via: "now" | "inline" }) =>
  settle(client.POST("/api/asks/{id}/answer", { ...params(id), body }));

export const dismissAsk = (id: number, ifVersion: number) => settle(client.POST("/api/asks/{id}/dismiss", { ...params(id), body: { if_version: ifVersion } }));

export const undismissAsk = (id: number, ifVersion: number) => settle(client.POST("/api/asks/{id}/undismiss", { ...params(id), body: { if_version: ifVersion } }));

/** snoozeAsk snoozes for a preset; the zone is the browser's, since "Tonight" and "Tomorrow" are the owner's local times. */
export const snoozeAsk = (id: number, preset: string) =>
  settle(client.PUT("/api/asks/{id}/snooze", { ...params(id), body: { preset: preset as "1h", tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }));

export const unsnoozeAsk = (id: number) => settle(client.DELETE("/api/asks/{id}/snooze", params(id)));
