// Crew: the agents and the machines they run on. The pages are lazy chunks; the allow-list helpers are light and shared.
import { registerHandler } from "@convoz/api-client";
import { createElement, lazy, Suspense, type ComponentType } from "react";
import { useCrew } from "./store.ts";

export { allowText, parseAllow } from "./allow.ts";

const page = (load: () => Promise<{ default: ComponentType }>): ComponentType => {
  const Lazy = lazy(load);
  return () => createElement(Suspense, { fallback: null }, createElement(Lazy));
};

export const Crew = page(() => import("./Crew.tsx").then((m) => ({ default: m.Crew })));
export const Machines = page(() => import("./Machines.tsx").then((m) => ({ default: m.Machines })));
export const AgentProfile = page(() => import("./AgentProfile.tsx").then((m) => ({ default: m.AgentProfile })));

// A status frame moves the rows with no reload; a status of an agent the list does not hold yet is read from the server.
registerHandler("agent.status_changed", (frame) => {
  if (frame.name !== "agent.status_changed") return;
  const crew = useCrew.getState();
  if (crew.statuses?.[frame.data.handle]) crew.changed(frame.data);
  else if (crew.statuses) void crew.load().catch(() => {});
});
