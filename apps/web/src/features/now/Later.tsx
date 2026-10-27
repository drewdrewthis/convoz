import { AskMenu, MenuItem, usePhone } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { toast } from "../pins-stars/index.ts";
import { laterOptionsAt } from "./presets.ts";
import { useNow } from "./store.ts";

/** laterMentions hides the mention card of a conversation until a time; a new @mention before then shows it again (issue 103). */
async function laterMentions(id: number, until: number): Promise<void> {
  await call(client.PUT("/api/conversations/{id}/mention-snooze", { params: { path: { id } }, body: { until } }));
  await data.loadConversations();
}

/** Later is the foot of a mention card: its buttons (`children`), then Later, and under them the menu of when the card comes back. It looks and works like the Snooze of an ask card. */
export function Later({ id, title, children }: { id: number; title: string; children: ReactNode }) {
  const { fail } = useNotice();
  const skew = useNow((s) => s.skew);
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);

  // The menu closes on a press outside it, and on Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (label: string, until: number) => {
    setOpen(false);
    laterMentions(id, until).then(
      () => toast(`${title} comes back in Now: ${label}`),
      (err) => fail(humanError(err)),
    );
  };

  return (
    <div ref={root}>
      <div className="flex items-center">
        {children}
        <Button variant="text" size="inline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Later
        </Button>
      </div>
      {open ? (
        <AskMenu sheet={phone} holder={sheet} shut={() => setOpen(false)}>
          {laterOptionsAt(Date.now() + skew).map((o) => (
            <MenuItem key={o.label} sheet={phone} onClick={() => pick(o.label, o.until)}>
              {o.label}
            </MenuItem>
          ))}
        </AskMenu>
      ) : null}
    </div>
  );
}
