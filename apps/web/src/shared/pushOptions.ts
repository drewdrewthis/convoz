import { pagePath } from "./pagePath.ts";

/** The payload the server sends: {v:1, reason, title, body?, url, badge, topic}. Anything else shows a plain notice. */
export interface PushPayload {
  reason?: string;
  title?: string;
  body?: string;
  url?: string;
  badge?: number;
  topic?: string;
}

/** NotificationOptions with renotify, which the TypeScript DOM types leave out. */
type ShownOptions = NotificationOptions & { renotify?: boolean };

/**
 * pushOptions is how the worker shows a push. The topic is the tag: a newer push on the same topic replaces the one still showing.
 * A plain message push does so without a second ring (renotify false; advisor before the PR 253 deploy: message pushes were too loud).
 */
export function pushOptions(p: PushPayload): ShownOptions {
  const shown: ShownOptions = { body: p.body ?? "", tag: p.topic, icon: "/assets/icon-192.png", data: { url: pagePath(p.url) } };
  return p.reason === "message" ? { ...shown, renotify: false } : shown;
}
