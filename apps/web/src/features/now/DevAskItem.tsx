import type { Ask } from "@convoz/api-client";
import { ReplyCount, whoLine, type SnoozePreset } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { AskApp } from "./AskApp.tsx";
import { askFrame, carriesApp, doneLine } from "./askView.ts";
import { ItemFrame } from "./DevFrame.tsx";
import { OkayGlyph, ReplyGlyph } from "./DevIcons.tsx";

interface DevAskItemProps {
  ask: Ask;
  busy: boolean;
  presets: SnoozePreset[];
  /** Okay: the recommended answer (a draft is sent as written). */
  okay: () => void;
  reply: () => void;
  snooze: (key: string) => void;
  menu: { label: string; run: () => void }[];
  replies?: { count?: number; unread?: number };
}

/** DevAskItem is an ask message of a conversation in the dev build, drawn as the one item layout (owner, conv 179 msg 12889, 12904): the same frame as the feed, with no From link, since it is already in its conversation, and no thread, since the message has its own. A closed ask is a done item with one line. */
export function DevAskItem({ ask, busy, presets, okay, reply, snooze, menu, replies }: DevAskItemProps) {
  const open = ask.state === "open";
  const { title, context } = askFrame(ask, whoLine(ask.asker));
  return (
    <ItemFrame
      kind={open ? "blocking" : "done"}
      title={title}
      context={open ? context : doneLine(ask)}
      tag={open && ask.urgent ? "Urgent" : undefined}
      from={{ id: ask.conversation_id, title: ask.conversation?.title ?? "" }}
      inChat
      menu={menu}
      app={carriesApp(ask) ? <AskApp ask={ask} /> : undefined}
      foot={replies?.count ? <ReplyCount count={replies.count} unread={replies.unread} /> : undefined}
      snooze={open ? { presets, pick: snooze } : undefined}
      busy={busy}
      dataId={ask.id}
      at={(open ? ask.created_at : ask.resolved_at) ?? ask.created_at}
      actions={
        open ? (
          <>
            <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={okay}>
              <OkayGlyph />
              Okay
            </Button>
            <Button variant="text" size="inline" onClick={reply}>
              <ReplyGlyph />
              Reply
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
