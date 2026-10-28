import type { Conversation, Message } from "@convoz/api-client";
import { useEffect, useMemo, useState } from "react";
import { source } from "../../shared/data.ts";
import { ALL, usePlans } from "../plan/index.ts";
import { titleOf } from "../rail/index.ts";
import { planItems, questionsOf, type Fyi } from "./feed.ts";

/** How many conversations are read for the owner's questions: the newest active ones. */
const WATCHED = 12;
const DAY = 86_400_000;

/** useQuestions reads the newest messages of the conversations that were active in the last day and finds the owner's questions in them. It reads again when a conversation has a new last message. */
function useQuestions(rows: readonly Conversation[] | null, me: string): Fyi[] {
  const [held, setHeld] = useState<Record<number, { key: string; list: Message[] }>>({});
  const live = useMemo(() => (rows ?? []).filter((c) => c.last_activity_at >= Date.now() - DAY).sort((a, b) => b.last_activity_at - a.last_activity_at).slice(0, WATCHED), [rows]);
  useEffect(() => {
    for (const c of live) {
      const k = `${c.last?.id ?? 0}`;
      if (held[c.id]?.key === k) continue;
      source.messages(c.id, { limit: 40 }).then(
        ({ messages }) => setHeld((h) => ({ ...h, [c.id]: { key: k, list: messages } })),
        () => {},
      );
    }
  }, [live, held]);
  return useMemo(() => {
    if (!me) return [];
    return live.flatMap((c) => {
      const list = held[c.id]?.list;
      const item = list ? questionsOf(c.id, titleOf(c), list, me, Date.now()) : null;
      return item ? [item] : [];
    });
  }, [held, live, me]);
}

/** useFyi are the fyi items of Now, all read from the server: the plan steps started or done today, and the owner's answered questions. */
export function useFyi(rows: readonly Conversation[] | null, me: string): Fyi[] {
  useEffect(() => void usePlans.getState().load(ALL).catch(() => {}), []);
  const board = usePlans((s) => s.boards[ALL]);
  const questions = useQuestions(rows, me);
  return useMemo(() => {
    const byId = new Map((rows ?? []).map((c) => [c.id, titleOf(c)]));
    return [...planItems(board, (id) => byId.get(id) ?? ""), ...questions];
  }, [board, rows, questions]);
}
