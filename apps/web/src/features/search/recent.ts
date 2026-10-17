// The conversations the owner opened last, newest first: what the search box lists before anything is typed. Kept on this device
// only; a browser that blocks storage simply has none.
const KEY = "convoz.recent-chats";
const KEPT = 5;

/** recentChats are the ids of the conversations opened last, newest first. */
export function recentChats(): number[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is number => Number.isInteger(id)).slice(0, KEPT) : [];
  } catch {
    return [];
  }
}

/** rememberChat puts a conversation first in the recent ones. */
export function rememberChat(id: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...recentChats().filter((x) => x !== id)].slice(0, KEPT)));
  } catch {
    /* storage is blocked: nothing to remember with */
  }
}
