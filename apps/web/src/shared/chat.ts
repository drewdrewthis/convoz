// Shared by the chat pages (Conversations, a conversation, New conversation and Crew).
import type { Identity } from "@convoz/api-client";

/** newId makes a client id (8 to 64 characters). getRandomValues also works where randomUUID does not (plain http). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** whenLabel is the short time in a list row: the clock today, then Yesterday, the weekday, the date. */
export function whenLabel(ms: number): string {
  const at = new Date(ms);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let timeFormat: Intl.DateTimeFormat | undefined;
const timeFormatter = () => (timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }));
// Building the formatter takes tens of milliseconds the first time. It is done as soon as the script has run, before the
// owner can type, so that the first message they send shows in the next frame (design §12.2: send to own bubble in 16 ms).
setTimeout(timeFormatter, 0);

/** clock is the time shown next to a name: "5:25 AM". */
export const clock = (ms: number): string => timeFormatter().format(ms);

/** onResume runs fn when the app comes back: bfcache restore, tab visible again, network back. Returns the undo. */
export function onResume(fn: () => void): () => void {
  const visible = () => {
    if (document.visibilityState === "visible") fn();
  };
  addEventListener("pageshow", fn);
  addEventListener("online", fn);
  document.addEventListener("visibilitychange", visible);
  return () => {
    removeEventListener("pageshow", fn);
    removeEventListener("online", fn);
    document.removeEventListener("visibilitychange", visible);
  };
}

/** initials is the avatar letter: the first letter of a handle (CSS upper-cases it). */
export const initials = (handle: string | undefined): string => (handle || "?").slice(0, 1);

// The prototype tints an agent by its place in the agent registry (index mod 6). The server lists agents in the order they were made,
// so a page sets the order once it has the crew; an agent not in it (not expected) falls back to a hash of its handle.
let registry: string[] = [];
let triaged = new Set<string>();
export const setRegistry = (people: Pick<Identity, "kind" | "handle" | "triage">[]): void => {
  registry = people.filter((p) => p.kind === "agent").map((p) => p.handle);
  triaged = new Set(people.filter((p) => p.triage).map((p) => p.handle));
};

/** isTriage says whether the crew the page last set lists the agent as a triage agent. */
export const isTriage = (handle: string): boolean => triaged.has(handle);

/** paletteOf is the avatar tint (0 to 5) of an agent: its index in the registry, mod 6. */
export function paletteOf(handle: string): number {
  const at = registry.indexOf(handle);
  if (at >= 0) return at % 6;
  let h = 0x811c9dc5;
  for (const ch of handle || "") h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h % 6;
}

/** stripCf drops format characters (bidi controls, zero-width) so text cannot reorder or hide what the owner reads.
 *  The server strips them from previews and rejects them in display names; titles and bodies are stored as sent, so they are stripped here.
 *  Display names are stripped too, as a guard for rows saved before ValidDisplayName rejected Cf. */
export const stripCf = (text: string): string => String(text).replace(/\p{Cf}/gu, "");
