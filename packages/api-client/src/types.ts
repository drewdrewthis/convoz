// The API's shapes, named. Generated from packages/contracts (schema.ts); never written by hand.
import type { components } from "./schema.ts";

export type { components, paths } from "./schema.ts";

type S = components["schemas"];
export type Conversation = S["Conversation"];
export type Message = S["Message"];
export type Person = S["Person"];
export type Identity = S["Identity"];
export type Me = S["Me"];
export type Passkey = S["Passkey"];
export type Machine = S["Machine"];
export type MachineRequest = S["MachineRequest"];
export type HostInfo = S["HostInfo"];
export type Allow = S["Allow"];
export type Posted = S["Posted"];
export type StepUpAction = S["StepUpAction"];
export type ApiErrorBody = S["Error"];
export type MessageCreatedFrame = S["MessageCreatedFrame"];
export type ReadMovedFrame = S["ReadMovedFrame"];
export type AgentWorkingFrame = S["AgentWorkingFrame"];

/** The named frames of GET /api/stream and their payloads. */
export interface StreamFrames {
  "message.created": MessageCreatedFrame;
  "read.moved": ReadMovedFrame;
  "conversation.created": Conversation;
  "agent.working": AgentWorkingFrame;
}
export type FrameName = keyof StreamFrames;
/** One frame: its name and its payload, so a switch on `name` narrows `data`. */
export type Frame<N extends FrameName = FrameName> = { [K in N]: { name: K; data: StreamFrames[K] } }[N];

/** Every frame name the stream sends, for the sync engine to listen to. */
export const FRAME_NAMES = ["message.created", "read.moved", "conversation.created", "agent.working"] as const satisfies readonly FrameName[];
