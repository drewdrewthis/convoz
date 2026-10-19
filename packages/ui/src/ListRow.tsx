import { createElement, type AllHTMLAttributes, type ElementType, type ReactNode } from "react";
import { cx } from "./cx.ts";

type Tag = "li" | "div" | "a" | "button" | "label" | "p";

interface Own {
  /** The element the row is: `li` (the default) inside a List, `a` or `button` for a row that goes or does something, `label` around a control, `div` or `p` for plain text. */
  as?: Tag;
  /** danger: a destructive row such as Sign out. */
  tone?: "danger";
  /** The content goes in a column, one line under the other, instead of side by side. */
  stacked?: boolean;
  /** A chevron at the end: the row opens another page. */
  chevron?: boolean;
  /** The title is bold: something in the row is new. */
  unread?: boolean;
  /** The row is the one on show: it carries `aria-current` and the selection tint. */
  selected?: boolean;
  /** Before the title, such as an avatar. */
  leading?: ReactNode;
  /** The first line. */
  title?: ReactNode;
  /** A muted line under the title. */
  sub?: ReactNode;
  /** At the end, such as a value, a control or a button. */
  trailing?: ReactNode;
}

export type ListRowProps = Own & Omit<AllHTMLAttributes<HTMLElement>, "title">;

// The row resets what the browser styles itself on a button (border, background, font), so it looks the same whichever element it is.
// A utility that a prop changes is set in one place only (gap, items, colour, background, weight): two of them on one element would be won by whichever Tailwind sorts last.
const base =
  "box-border flex w-full min-h-56 justify-between px-16 py-10 border-0 text-15 text-left no-underline [font-family:inherit]";

const chevronClasses =
  "box-content size-9 rotate-45 border-0 border-t-2 border-r-2 border-solid border-t-muted border-r-muted";

/**
 * ListRow is one row of a list: a leading slot, a title with a muted line under it, a trailing slot. Anything else goes in `children`
 * (it then replaces the title and the line). Put rows in a {@link List}; the List draws the line between them.
 */
export function ListRow({ as = "li", tone, stacked, chevron, unread, selected, leading, title, sub, trailing, className, children, ...rest }: ListRowProps) {
  const acts = as === "a" || as === "button" || as === "label";
  const classes = cx(
    base,
    acts && !stacked ? "cursor-pointer" : "cursor-default",
    tone === "danger" ? "text-danger" : "text-text",
    stacked ? "flex-col items-stretch gap-4" : "items-center gap-12",
    selected ? "bg-selection" : "bg-transparent",
    unread ? "font-semibold" : "[font-weight:inherit]",
    className,
  );
  const line =
    title !== undefined || sub !== undefined ? (
      <span className="min-w-0 grow">
        {title}
        {sub !== undefined ? <span className="[display:block] text-13 font-normal text-muted">{sub}</span> : null}
      </span>
    ) : null;
  const props = { ...rest, className: classes, "aria-current": selected ? ("true" as const) : rest["aria-current"], ...(as === "button" ? { type: rest.type ?? "button" } : null) };
  return createElement(
    as as ElementType,
    props,
    leading,
    line,
    children,
    trailing,
    chevron ? <span aria-hidden="true" className={chevronClasses} /> : null,
  );
}

/** List is the raised box that holds ListRows (or `li`s of them): rounded, edged, with a line between the rows. */
export function List({ as: Tag = "ul", className, ...rest }: { as?: "ul" | "ol" | "div" | "section" } & AllHTMLAttributes<HTMLElement>) {
  const classes = cx(
    "m-0 mb-16 p-0 list-none overflow-hidden rounded-[14px] border border-solid border-border bg-raised",
    "[&>*]:[border-top:1px_solid_var(--color-border)] [&>:first-child]:border-t-0",
    className,
  );
  return createElement(Tag, { ...rest, className: classes });
}
