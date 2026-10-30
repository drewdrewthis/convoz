import { Button } from "@convoz/ui/Button";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useMemo, useState } from "react";
import { withBase } from "../../shared/base.ts";
import { usePath } from "../../shared/navigate.ts";
import { useNoticeState, type Notice } from "../../shared/notice.tsx";
import { toast } from "../pins-stars/index.ts";
import { useSearchUi } from "../search/index.ts";
import { okayAnswer } from "./askView.ts";
import { DevAskItem } from "./DevAskItem.tsx";
import { usePopSeen } from "./popSeen.ts";
import { popsOn, toPop, type Pop } from "./popup.ts";
import { RequestCard } from "./requests.tsx";
import { useNow } from "./store.ts";
import { useAskActions } from "./useAskActions.ts";

/**
 * UrgentHost pops the next urgent thing the owner has not put off (toPop): a connect request or an urgent ask, with its own
 * buttons and Later. Later or Escape marks it seen, so it does not pop again; it stays in Now. Acting on it takes it out of Now,
 * and the next one pops. It is drawn on every signed-in page but Now, and waits while another dialog is open (popsOn) (owner, 2026-10-30: "anything that's urgent should be a popup").
 */
/**
 * sheetOpen is whether a sheet other than the popup is open. Every sheet is a <dialog> that Sheet portals straight into <body> and
 * that is there only while it is open (its parent closes it by unmounting it), so the direct children of <body> tell.
 */
function sheetOpen(): boolean {
  return [...document.body.children].some((n) => n.tagName === "DIALOG" && !n.querySelector("[data-urgent]"));
}

/** useOtherDialog follows whether a sheet or the Search overlay is open. Only <body>'s own children are watched, not the page. */
function useOtherDialog(): boolean {
  const [sheet, setSheet] = useState(sheetOpen);
  const search = useSearchUi((s) => s.open);
  useEffect(() => {
    const watch = new MutationObserver(() => setSheet(sheetOpen()));
    watch.observe(document.body, { childList: true });
    return () => watch.disconnect();
  }, []);
  return sheet || search;
}

export function UrgentHost() {
  const now = useNow((s) => s.now);
  const seen = usePopSeen((s) => s.seen);
  const [alert, setAlert] = useState("");
  const { Provider } = useNoticeState();
  // The cards report into the popup, not into the page under it: a failure shows in the sheet, a success as a toast.
  const notice = useMemo<Notice>(() => ({ say: (text) => void (text && toast(text)), fail: setAlert }), []);
  const covered = useOtherDialog();
  // usePath, not appPath: a page the app opens without a load (navigate, Back) must take the popup down or bring it up.
  const path = usePath();
  const pop = popsOn(path, covered) ? toPop(now, seen)[0] : undefined;
  if (!pop) return null;
  return (
    <Provider value={notice}>
      <UrgentSheet key={pop.key} pop={pop} alert={alert} clear={() => setAlert("")} />
    </Provider>
  );
}

function UrgentSheet({ pop, alert, clear }: { pop: Pop; alert: string; clear: () => void }) {
  const now = useNow((s) => s.now);
  const load = useNow((s) => s.load);
  const see = usePopSeen((s) => s.see);
  const reload = async () => {
    clear();
    await load();
  };
  const actions = useAskActions({ now, asks: now?.asks ?? [], reload, onAnswered: () => {} });
  const later = () => {
    clear();
    see(pop.key);
  };
  return (
    <Sheet
      title={pop.kind === "ask" ? "Urgent ask" : "Machine request"}
      alert={alert}
      onClose={later}
      actions={
        <Button id="urgent-later" onClick={later}>
          Later
        </Button>
      }
    >
      {/* The mark that keeps the popup from counting itself as another dialog (otherDialog). */}
      <div data-urgent="">
        {pop.kind === "ask" ? (
          <DevAskItem
            ask={pop.ask}
            busy={actions.busy.has(pop.ask.id)}
            presets={actions.presets}
            okay={() => void actions.answer(pop.ask, okayAnswer(pop.ask))}
            reply={() => {
              later();
              location.assign(withBase(`/chats/${pop.ask.conversation_id}#reply=${pop.ask.thread_root_id ?? pop.ask.id}`));
            }}
            snooze={(k) => void actions.snooze(pop.ask, k)}
            menu={[]}
          />
        ) : (
          <RequestCard item={pop} changed={reload} />
        )}
      </div>
    </Sheet>
  );
}
