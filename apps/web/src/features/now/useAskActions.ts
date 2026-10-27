import type { Ask, Now } from "@convoz/api-client";
import type { Answer } from "@convoz/app-kit";
import { useEffect, useRef, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { toast } from "../pins-stars/index.ts";
import { presetsAt } from "./presets.ts";
import { answerAsk, dismissAsk, snoozeAsk, undismissAsk, unsnoozeAsk, useNow, type Settled } from "./store.ts";

/** lostNote tells a person whose answer lost the race what the ask says now. */
function lostNote(won: Ask, tried: string): string {
  const how = won.state === "answered" ? `Already ${won.chosen?.kind === "custom" ? "replied" : "answered"}: ${won.answer ?? ""}.` : `The ask is ${won.state} now.`;
  return `${how} Your answer "${tried}" was not used.`;
}

/** clockText is a time of day as the owner reads it: "6:00 PM". */
const clockText = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * useAskActions is what the owner does to the asks of the feed: answer, dismiss, snooze, and the undo of each. A change runs once at a time per ask;
 * where the card goes away, focus moves to its neighbour so the keys go on working. `onAnswered` runs when an ask turned into an answer.
 */
export function useAskActions({ now, asks, reload, onAnswered }: { now: Now | null; asks: Ask[]; reload: () => Promise<void>; onAnswered: () => void }) {
  const { say, fail } = useNotice();
  const skew = useNow((s) => s.skew);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const focusAfter = useRef<number | null>(null);
  const presets = presetsAt(Date.now() + skew);

  // After a card leaves the list the next one takes the focus.
  useEffect(() => {
    if (focusAfter.current === null) return;
    document.querySelector<HTMLElement>(`[data-ask="${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  }, [now]);

  /** act runs one change of an ask once at a time. Where the card goes away, focus moves to its neighbour. */
  const act = async (ask: Ask, leaves: boolean, run: () => Promise<Settled>, label?: string): Promise<Settled | null> => {
    if (busy.has(ask.id)) return null;
    setBusy((b) => new Set(b).add(ask.id));
    if (leaves) {
      const at = asks.findIndex((a) => a.id === ask.id);
      focusAfter.current = (asks[at + 1] ?? asks[at - 1])?.id ?? null;
    }
    try {
      const r = await run();
      if (r.ask.state === "answered") onAnswered();
      if (r.lost) say(label ? lostNote(r.ask, label) : `The ask is ${r.ask.state} now. Nothing was changed.`);
      await reload();
      return r;
    } catch (err) {
      fail(humanError(err));
      return null;
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(ask.id);
        return next;
      });
    }
  };

  /** undoing reverses only the change the toast announced; if the ask moved on meanwhile, the server says so and nothing changes. */
  const undo = (run: () => Promise<Settled>) => () => run().then(reload, (err) => fail(humanError(err)));

  const dismiss = async (ask: Ask) => {
    const r = await act(ask, true, () => dismissAsk(ask.id, ask.version));
    if (r && !r.lost) toast("Dismissed", undo(() => undismissAsk(ask.id, r.ask.version)));
  };

  const snooze = async (ask: Ask, preset: string) => {
    const r = await act(ask, true, () => snoozeAsk(ask.id, preset));
    if (!r || r.lost) return;
    const label = presets.find((p) => p.key === preset)?.label ?? preset;
    toast(`Snoozed until ${label}, ${clockText(r.ask.snoozed_until ?? 0)}`, undo(() => unsnoozeAsk(ask.id)));
  };

  /** After an answer the toast says where the ask went: Answered today, or You replied when the reply keeps it open. */
  const answer = async (ask: Ask, a: Answer) => {
    const label = a.choice === "custom" || (ask.draft && a.choice === "recommended") ? (a.text ?? "") : (ask.options[a.choice === "alternative" ? (a.index ?? 1) : 0]?.label ?? "");
    const r = await act(ask, true, () => answerAsk(ask.id, { ...a, if_version: ask.version, via: "now" }), label);
    if (r && !r.lost) toast(r.ask.state === "answered" ? "Answered. The ask moved to Answered today." : "Replied. The ask moved to You replied.");
  };

  const unsnooze = (ask: Ask) => void act(ask, false, () => unsnoozeAsk(ask.id));
  const reopen = (ask: Ask) => void act(ask, false, () => undismissAsk(ask.id, ask.version));

  return { busy, presets, answer, dismiss, snooze, unsnooze, reopen };
}
