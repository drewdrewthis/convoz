// What the owner can do to the rail: star, mute, move. Each updates the cache at once and then takes the server's answer (the
// real ranks), so a drop never waits for the network; a refusal brings the list back from the server.
import type { Conversation } from "@convoz/api-client";
import { call, client } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";
import { byRank, FOREVER, isOlder } from "./model.ts";

const rows = (): Conversation[] => data.store.getState().conversations ?? [];
/** One row, from the list or, on a page that never loaded the list, from the conversation it holds. */
const find = (id: number): Conversation | undefined => rows().find((c) => c.id === id) ?? data.store.getState().rows[id];

async function patch(id: number, body: { starred?: boolean; muted_until?: number | null; place?: { after: number | null } }): Promise<void> {
  try {
    data.applyPrefs(await call(client.PATCH("/api/conversations/{id}/prefs", { params: { path: { id } }, body })));
  } catch (err) {
    void data.loadConversations().catch(() => {});
    throw err;
  }
}

/** The group a row sits in, in the owner's order. */
const section = (starred: boolean): Conversation[] => rows().filter((c) => c.starred === starred).sort(byRank);

/** A key that puts a row after `after` in a section (null: first), the way the server will, until the server's answer replaces it. */
function guess(list: Conversation[], after: number | null): number {
  const at = after === null ? -1 : list.findIndex((c) => c.id === after);
  const above = at >= 0 ? list[at] : undefined;
  const below = list[at + 1];
  if (above && below) return (above.rank + below.rank) / 2;
  if (above) return above.rank - 1;
  return (below?.rank ?? Date.now()) + 1;
}

/** moveRow puts a conversation into a group, directly after `after` (null: at the top of it). */
export async function moveRow(id: number, starred: boolean, after: number | null): Promise<void> {
  const was = find(id);
  if (!was) return;
  const others = section(starred).filter((c) => c.id !== id);
  data.patchConversation(id, { starred, rank: guess(others, after) });
  await patch(id, { ...(was.starred === starred ? {} : { starred }), place: { after } });
}

/** setStar stars or unstars: it goes to the top of the group it lands in. */
export async function setStar(id: number, starred: boolean): Promise<void> {
  const was = find(id);
  if (was) data.patchConversation(id, { starred, rank: guess(section(starred), null) });
  await patch(id, { starred });
}

/** setClosed closes a conversation (the stale mark: the rail folds it into Older until the next message) or reopens it. */
export async function setClosed(id: number, closed: boolean): Promise<void> {
  data.patchConversation(id, { stale: closed || undefined });
  try {
    await call(client.POST("/api/conversations/{id}/stale", { params: { path: { id } }, body: closed ? {} : { reopen: true } }));
  } finally {
    void data.loadConversations().catch(() => {});
  }
}

/** setMute mutes for good, or unmutes. A muted conversation pushes nothing but stays in Now. */
export async function setMute(id: number, muted: boolean): Promise<void> {
  if (muted) data.patchConversation(id, { muted_until: FOREVER });
  else data.patchConversation(id, { muted_until: undefined });
  await patch(id, { muted_until: muted ? FOREVER : null });
}

/**
 * stepRow moves a row one place up or down for the keyboard. Past the top of Conversations it joins Starred, past the bottom of
 * Starred it leaves it (the prototype's railMove). It answers what it did, for the live region.
 */
export async function stepRow(id: number, dir: -1 | 1): Promise<string | null> {
  const c = rows().find((x) => x.id === id);
  if (!c) return null;
  const mine = section(c.starred).filter((x) => c.starred || !isOlder(x)); // Older is folded away: a step passes what is in view
  const at = mine.findIndex((x) => x.id === id);
  const listAfter = (list: Conversation[], index: number): number | null => (index < 0 ? null : (list[index]?.id ?? null));
  let starred = c.starred;
  let after: number | null;
  if (dir < 0 && at === 0) {
    if (c.starred) return "first";
    starred = true;
    after = section(true).at(-1)?.id ?? null; // the bottom of Starred
  } else if (dir > 0 && at === mine.length - 1) {
    if (!c.starred) return "last";
    starred = false;
    after = null; // the top of Conversations
  } else {
    after = listAfter(mine, dir < 0 ? at - 2 : at + 1);
  }
  await moveRow(id, starred, after);
  return null;
}
