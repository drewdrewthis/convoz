import type { Conversation } from "@convoz/api-client";
import { stripCf } from "../../shared/chat.ts";
import { humanError } from "../../shared/api.ts";
import { toast } from "./toast.ts";
import { unpinMessage } from "./actions.ts";
import { Button } from "@convoz/ui/Button";

/** PinnedList is "Pinned in this conversation": the messages the owner pinned, newest pin first, each a link back to the message. */
export function PinnedList({ row }: { row: Conversation }) {
  const pinned = row.pinned ?? [];
  return (
    <section aria-labelledby="det-pins" className="detsec">
      <div className="dethead">
        <h3 id="det-pins">Pinned in this conversation</h3>
      </div>
      {pinned.length ? (
        <ul aria-label="Pinned messages" className="plist">
          {pinned.map((m) => (
            <li key={m.id} className="prow pinrow">
              <a className="pintext" href={`/chats/${row.id}#m${m.id}`}>
                <span className="text-13 text-muted">{m.author.kind === "agent" ? `@${m.author.handle}` : m.author.display_name || m.author.handle}</span>
                <span>{stripCf(m.body)}</span>
              </a>
              <Button variant="quiet" size="small" aria-label="Unpin message" onClick={() => unpinMessage(row.id, m.id).catch((err) => toast(humanError(err)))}>
                Unpin
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">Nothing pinned yet.</p>
      )}
    </section>
  );
}
