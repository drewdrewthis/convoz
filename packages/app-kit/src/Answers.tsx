import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@convoz/ui/Button";
import { cx } from "@convoz/ui/cx";
import { qaPairs, type AskData, type QaPair } from "./askData.ts";
import { linkText } from "./linkText.tsx";

/**
 * Answers is the Q&A block of an ask the agent updated after the owner's questions: its own section under the question, with an accent
 * edge, each question of the owner (muted, the owner's own words) over the agent's answer. What is new reads at a glance (owner, msg 2064);
 * a long answer folds, at 4 lines (3 on a phone) so the options stay on the first screen of the card, with "More" of its own.
 */
export function Answers({ ask, phone, className }: { ask: AskData; phone: boolean; className?: string }) {
  const id = useId();
  const pairs = qaPairs(ask.answers ?? "", ask.owner_reply?.text);
  return (
    <div role="group" aria-labelledby={id} className={cx("mt-8 mb-6 flex flex-col gap-8 border-0 border-l-2 border-solid border-accent pl-10", className)}>
      <p id={id} className="m-0 text-13 leading-[18px] font-semibold text-text">{`Your questions, answered · ${pairs.length}`}</p>
      {pairs.map((p, i) => (
        <Pair key={i} pair={p} phone={phone} />
      ))}
    </div>
  );
}

/** Pair is one question of the owner over the agent's answer, which folds on its own. */
function Pair({ pair, phone }: { pair: QaPair; phone: boolean }) {
  const [more, setMore] = useState(false);
  const [long, setLong] = useState(false);
  const answer = useRef<HTMLParagraphElement | null>(null);
  // Whether the answer is cut is measured, not guessed from its length: it hangs on the width of the card and the font.
  useLayoutEffect(() => {
    const el = answer.current;
    if (!el || more) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, [pair.a, phone, more]);
  return (
    <div className="flex flex-col gap-2">
      {pair.q ? (
        <p data-q="" className="m-0 text-13 leading-[18px] text-muted [overflow-wrap:anywhere]">
          {linkText(pair.q)}
        </p>
      ) : null}
      {pair.a ? (
        <p ref={answer} data-a="" className={cx("m-0 whitespace-pre-line text-14 leading-[20px] text-text [overflow-wrap:anywhere]", !more && (phone ? "line-clamp-3" : "line-clamp-4"))}>
          {linkText(pair.a)}
        </p>
      ) : null}
      {long ? (
        <Button variant="text" size="inline" className="self-start -ml-8" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </Button>
      ) : null}
    </div>
  );
}
