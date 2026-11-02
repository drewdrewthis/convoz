import { CloseIcon } from "@convoz/ui/icons";
import { IconButton } from "@convoz/ui/IconButton";
import type { UnfurlCard } from "@convoz/api-client";
import { useEffect, useState } from "react";
import { useMediaAutoLoads } from "../../../shared/media.ts";
import { unfurlOf } from "./actions.ts";

/** An address in a message body: the first one gets the card (the server decides the same way). */
const LINK = /https?:\/\/[^\s)\]<>]+/i;

/** hasLink says whether a body has an address a preview could be made for. */
export const hasLink = (body: string): boolean => LINK.test(body);

/** The card is asked for once the message is drawn, and again every 3 s while the server is still fetching it, up to this many times. */
const PENDING_TRIES = 5;
const PENDING_MS = 3000;

/** What the server said, by message id, so a row drawn again (the log is virtualized) does not ask again. `null`: no card. */
const answered = new Map<number, UnfurlCard | null>();

const STATE = { open: "Open", merged: "Merged", closed: "Closed" } as const;

/**
 * LinkPreview is the card under a message that has a link (prototype: "Preview" / "Hide preview" and the card). It shows only what the
 * server sent for a person who can see the message; where there is no card (previews off for the host, a site that did not answer)
 * it draws nothing at all. `card` is the one the message list carried: with it the card needs no request of its own.
 */
export function LinkPreview({ id, card: sent }: { id: number; card?: UnfurlCard }) {
  const auto = useMediaAutoLoads();
  const [tapped, setTapped] = useState(false);
  const armed = auto || tapped;
  const [fetched, setCard] = useState<UnfurlCard | null>(answered.get(id) ?? null);
  // The list carries the card; the per-message request is only the fallback while it is pending or absent (an unavailable card is final, too).
  const done = sent !== undefined && sent.status !== "pending";
  const card = done ? sent : fetched;
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!armed || done || answered.has(id)) return;
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
  }, [id, armed, done]);

  if (!armed) {
    // The card's size is not known before the server fetches it, so the placeholder can only say it waits.
    return (
      <button type="button" className="previewbtn" aria-expanded="false" onClick={() => setTapped(true)}>
        <span>Preview · tap to load</span>
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
      <IconButton variant="muted" size={32} glyph={12} className="absolute top-0 right-0 max-[600px]:size-44" label="Hide preview" onClick={onHide}>
        <CloseIcon />
      </IconButton>
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
