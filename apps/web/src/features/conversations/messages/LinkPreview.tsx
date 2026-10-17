import type { UnfurlCard } from "@convoz/api-client";
import { useEffect, useState } from "react";
import { unfurlOf } from "./actions.ts";

/** An address in a message body: the first one gets the card (the server decides the same way). */
const LINK = /https?:\/\/[^\s)\]<>]+/i;

/** hasLink says whether a body has an address a preview could be made for. */
export const hasLink = (body: string): boolean => LINK.test(body);

/** The card is asked for once the message is drawn, and again every 3 s while the server is still fetching it, up to this many times. */
const PENDING_TRIES = 5;
const PENDING_MS = 3000;

interface Connection {
  saveData?: boolean;
  effectiveType?: string;
}

/** On Save-Data or a slow network nothing is fetched until a tap (design §12.3). */
function slowNetwork(): boolean {
  const c = (navigator as Navigator & { connection?: Connection }).connection;
  return Boolean(c?.saveData) || ["slow-2g", "2g", "3g"].includes(c?.effectiveType ?? "");
}

/** What the server said, by message id, so a row drawn again (the log is virtualized) does not ask again. `null`: no card. */
const answered = new Map<number, UnfurlCard | null>();

const STATE = { open: "Open", merged: "Merged", closed: "Closed" } as const;

/**
 * LinkPreview is the card under a message that has a link (prototype: "Preview" / "Hide preview" and the card). It shows only what the
 * server sent for a person who can see the message; where there is no card (previews off for the host, a site that did not answer)
 * it draws nothing at all.
 */
export function LinkPreview({ id }: { id: number }) {
  const [slow] = useState(slowNetwork);
  const [armed, setArmed] = useState(!slow);
  const [card, setCard] = useState<UnfurlCard | null>(answered.get(id) ?? null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!armed || answered.has(id)) return;
    let off = false;
    let timer = 0;
    const load = async (n: number) => {
      try {
        const c = await unfurlOf(id);
        if (off) return;
        if (c.status === "pending" && n < PENDING_TRIES) timer = window.setTimeout(() => void load(n + 1), PENDING_MS);
        else {
          answered.set(id, c);
          setCard(c);
        }
      } catch {
        answered.set(id, null); // no card for this message: draw nothing
      }
    };
    void load(0);
    return () => {
      off = true;
      clearTimeout(timer);
    };
  }, [id, armed]);

  if (!armed) {
    return (
      <button type="button" className="previewbtn" aria-expanded="false" onClick={() => setArmed(true)}>
        <span>Preview</span>
      </button>
    );
  }
  if (card?.status !== "ok") return null;
  return (
    <>
      <button type="button" className="previewbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{open ? "Hide preview" : "Preview"}</span>
      </button>
      {open ? <Card card={card} onHide={() => setOpen(false)} /> : null}
    </>
  );
}

function Card({ card, onHide }: { card: UnfurlCard; onHide(): void }) {
  const domain = hostOf(card.url);
  const gh = card.kind === "github_pr" || card.kind === "github_issue";
  const state = STATE[card.meta?.state ?? "open"];
  return (
    <div className="unfurl" role="group" aria-label="Link preview" data-kind={card.kind}>
      <span className="unfurl-letter" aria-hidden="true">
        {domain.charAt(0).toUpperCase()}
      </span>
      <div className="unfurl-body">
        <span className="unfurl-site">
          {domain}
          {gh ? ` · ${card.meta?.repo} · #${card.meta?.number}` : ""}
        </span>
        <a className="unfurl-title" href={card.url} target="_blank" rel="noopener noreferrer">
          {card.title}
        </a>
        {gh ? (
          <span className="unfurl-state" data-state={card.meta?.state ?? "open"}>
            {state}
          </span>
        ) : null}
        {card.description ? <span className="unfurl-desc">{card.description}</span> : null}
      </div>
      <button type="button" className="unfurl-x" aria-label="Hide preview" title="Hide preview" onClick={onHide}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
