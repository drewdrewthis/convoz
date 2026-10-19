import { createElement, type AllHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx.ts";

interface Own {
  /** inline: one muted line in a list's place. compact: the same, tighter, for a popover. note: a centred hint under a transcript. page: the whole screen's worth, centred, with an optional icon and action. */
  variant?: "inline" | "compact" | "note" | "page";
  /** Drawn above the message (a line icon of 56px). `page` only. */
  icon?: ReactNode;
  /** Below the message, such as a Button. `page` only. */
  action?: ReactNode;
}

export type EmptyStateProps = Own & Omit<AllHTMLAttributes<HTMLElement>, "title" | "action">;

const variants = {
  inline: "m-0 mb-12 p-16 text-muted",
  compact: "m-0 p-8 text-muted",
  note: "mx-auto my-0 max-w-[760px] px-16 py-56 text-center text-14 text-muted",
  page: "flex flex-1 flex-col items-center justify-center gap-8 px-16 py-48 text-center",
};

// An icon here is a line drawing: it takes the muted colour and the stroke of the rest of the app, whatever it draws.
const icon = "[&_svg]:size-56 [&_svg]:fill-none [&_svg]:stroke-muted [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:1.4]";

/**
 * EmptyState says there is nothing to show yet, and what to do about it. The message is its children; it is a `p`, except for `page`,
 * which is a `div` holding the message as a `p` between its icon and its action.
 */
export function EmptyState({ variant = "inline", icon: glyph, action, className, children, ...rest }: EmptyStateProps) {
  if (variant !== "page") return createElement("p", { ...rest, className: cx(variants[variant], className) }, children);
  return createElement(
    "div",
    { ...rest, className: cx(variants.page, glyph ? icon : undefined, className) },
    glyph as ReactNode,
    <p className="m-0 mb-12 text-15 text-muted">{children}</p>,
    action as ReactNode,
  );
}
