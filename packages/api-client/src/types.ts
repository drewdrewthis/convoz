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
export type IdentityRequest = S["IdentityRequest"];
export type HandleRequest = S["HandleRequest"];
export type AgentIntro = S["AgentIntro"];
export type HostInfo = S["HostInfo"];
export type Allow = S["Allow"];
export type Posted = S["Posted"];
export type StepUpAction = S["StepUpAction"];
export type ApiErrorBody = S["Error"];
export type MessageCreatedFrame = S["MessageCreatedFrame"];
export type ReadMovedFrame = S["ReadMovedFrame"];
export type AgentWorkingFrame = S["AgentWorkingFrame"];
export type MessageSeenFrame = S["MessageSeenFrame"];
export type Seen = S["Seen"];
export type PrefsRequest = S["PrefsRequest"];
export type PrefsResponse = S["PrefsResponse"];
export type RailRank = S["RailRank"];
export type PrefsChangedFrame = S["PrefsChangedFrame"];
export type PinChangedFrame = S["PinChangedFrame"];
export type AgentStatusChangedFrame = S["AgentStatusChangedFrame"];
export type SyncEvent = S["SyncEvent"];
export type SyncAnswer = S["SyncAnswer"];
export type SyncDelta = S["SyncDelta"];
export type SyncSnapshot = S["SyncSnapshot"];
export type EditHistory = S["EditHistory"];
export type UnfurlCard = S["UnfurlCard"];
export type SearchResponse = S["SearchResponse"];
export type SearchResult = S["SearchResult"];
export type SearchConversation = S["SearchConversation"];
export type SearchFilter = S["SearchFilter"];
export type SearchPart = S["SearchPart"];
export type Ask = S["Ask"];
export type AskAnswerRequest = S["AskAnswerRequest"];
export type Now = S["Now"];
export type NowPendingAdd = S["NowPendingAdd"];
export type Upload = S["Upload"];
export type UploadState = S["UploadState"];
export type CreateUpload = S["CreateUpload"];
/** A message frame after the message changed: the message as it is now, with the conversation it is in. */
export type MessageChangedFrame = Message & { conversation_id: number; author_handle: string };
export interface ThreadUpdatedFrame {
  conversation_id: number;
  root_id: number;
  reply_count: number;
  last_reply_id: number;
  /** When the newest reply came (ms); absent from a server that does not send it. */
  last_reply_at?: number;
}

/** The named frames of GET /api/stream and their payloads. */
export interface StreamFrames {
  "message.created": MessageCreatedFrame;
  "message.edited": MessageChangedFrame;
  "message.deleted": MessageChangedFrame;
  "message.purged": MessageChangedFrame;
  "thread.updated": ThreadUpdatedFrame;
  "read.moved": ReadMovedFrame;
  "conversation.created": Conversation;
  "agent.working": AgentWorkingFrame;
  /** An agent's claim now covers the newest message a person wrote in a place: live only, the stored rows are on the conversation. */
  "message.seen": MessageSeenFrame;
  /** An ask changed (asked, answered, dismissed, snoozed, woke): the ask as this reader sees it now. */
  "ask.changed": Ask;
  /** A voice note got its words: the message as it reads now. */
  "upload.transcribed": MessageChangedFrame;
  "prefs.changed": PrefsChangedFrame;
  "pin.changed": PinChangedFrame;
  "agent.status_changed": AgentStatusChangedFrame;
}
export type FrameName = keyof StreamFrames;
/** One frame: its name and its payload, so a switch on `name` narrows `data`. */
export type Frame<N extends FrameName = FrameName> = { [K in N]: { name: K; data: StreamFrames[K] } }[N];

/** Every frame name the stream sends, for the sync engine to listen to. */
export const FRAME_NAMES = [
  "message.created",
  "message.edited",
  "message.deleted",
  "message.purged",
  "thread.updated",
  "read.moved",
  "conversation.created",
  "agent.working",
  "message.seen",
  "ask.changed",
  "upload.transcribed",
  "prefs.changed",
  "pin.changed",
  "agent.status_changed",
] as const satisfies readonly FrameName[];
