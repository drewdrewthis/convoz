import { Button } from "@convoz/ui/Button";
import { Sheet } from "@convoz/ui/Sheet";
import { useMemo, useState } from "react";
import { appPath, withBase } from "../../shared/base.ts";
import { useNoticeState, type Notice } from "../../shared/notice.tsx";
import { toast } from "../pins-stars/index.ts";
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
 * and the next one pops. It is drawn on every signed-in page but Now (popsOn) (owner, 2026-10-30: "anything that's urgent should be a popup").
 */
export function UrgentHost() {
  const now = useNow((s) => s.now);
  const seen = usePopSeen((s) => s.seen);
  const [alert, setAlert] = useState("");
  const { Provider } = useNoticeState();
  // The cards report into the popup, not into the page under it: a failure shows in the sheet, a success as a toast.
  const notice = useMemo<Notice>(() => ({ say: (text) => void (text && toast(text)), fail: setAlert }), []);
  const pop = popsOn(appPath()) ? toPop(now, seen)[0] : undefined;
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
    </Sheet>
  );
}
