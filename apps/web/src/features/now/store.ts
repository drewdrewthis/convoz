// Now's state: the machine requests waiting for the owner. The tab bar's badge reads it on every signed-in page.
import type { MachineRequest } from "@convoz/api-client";
import { create } from "zustand";
import { call, client } from "../../shared/api.ts";

interface NowState {
  machineRequests: MachineRequest[] | null;
  loadMachineRequests(): Promise<MachineRequest[]>;
}

export const useNow = create<NowState>()((set) => ({
  machineRequests: null,
  loadMachineRequests: async () => {
    const machineRequests = (await call(client.GET("/api/now"))).machine_requests;
    set({ machineRequests });
    return machineRequests;
  },
}));
