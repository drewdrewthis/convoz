import { forwardRef, type ComponentPropsWithoutRef, type Ref } from "react";
import { cx } from "./cx.ts";

export type ButtonVariant = "primary" | "quiet" | "danger" | "text" | "muted" | "dashed";
export type ButtonSize = "small" | "inline" | "option" | "chip";

interface Own {
  /** primary: the accent gradient, the one action of a screen. quiet: text only. danger: a destructive action. text: muted text with no edge, an action on a card. muted: a raised pill with muted text, a toggle that names a fold. dashed: a raised pill with a dashed edge, the way out of a list of options. Left out: the plain raised pill. */
  variant?: ButtonVariant;
  /** small: as wide as its label, 44px tall. inline: the same height with 13px text and no edge, for the actions of a card. option: full width, 50px tall, 14px text, one answer of a list. chip: as wide as its label, 44px tall, 13px text. Left out: the full width of its container. */
  size?: ButtonSize;
}

/** A link looking like a button is an `<a>` (give it `href`); anything else is a `<button>` that does not submit unless `type="submit"`. */
export type ButtonProps = Own & ({ href?: undefined } & ComponentPropsWithoutRef<"button"> | { href: string } & ComponentPropsWithoutRef<"a">);

// The button resets what the browser styles itself (font, margin, border, background), so it looks the same in the app and in the story book.
// Size and variant each own their properties (the edge, the weight, the gap, the padding): two utilities for one property on one element are won by whichever Tailwind sorts last.
const base =
  "box-border inline-flex items-center justify-center " +
  "rounded-full text-center no-underline cursor-pointer [font-family:inherit] " +
  "[transition:transform_140ms_ease,opacity_140ms_ease] [&:active:not(:disabled)]:[transform:scale(.98)] " +
  "disabled:opacity-45 disabled:cursor-default aria-busy:opacity-70";

const variants: Record<ButtonVariant | "plain", string> = {
  plain: "border-solid border-border bg-raised text-text",
  primary: "border-solid bg-transparent bg-(image:--grad) border-transparent text-on-accent",
  quiet: "border-solid bg-transparent border-transparent text-accent-text",
  danger: "border-solid border-border bg-raised text-danger",
  text: "border-solid bg-transparent border-transparent text-muted hover:text-text",
  muted: "border-solid border-border bg-raised text-muted aria-expanded:text-text",
  dashed: "border-dashed border-border bg-raised text-muted",
};

/** The size of a button: its box, its text, its edge and its weight (a primary button is always semibold, the rest of the small ones medium). */
function sized(size: ButtonSize | undefined, variant: ButtonVariant | undefined): string {
  const weight = variant === "primary" ? "font-semibold" : "font-medium";
  switch (size) {
    case "small":
      return "w-auto min-h-44 gap-8 border px-16 text-14 font-semibold";
    case "inline":
      return cx("w-auto min-h-44 gap-4 border-0 whitespace-nowrap text-13", variant === "primary" ? "px-18" : "px-8", weight);
    case "option":
      return cx("w-full min-h-50 gap-8 border px-16 text-14", weight);
    case "chip":
      return "w-auto min-h-44 gap-6 border px-14 text-13 font-medium";
    default:
      return cx("w-full gap-8 border px-22 text-15 font-semibold", variant === "quiet" ? "min-h-48" : "min-h-50");
  }
}

/**
 * Button is the app's one pill button. It forwards its ref and every other prop to the `<button>` or `<a>` it draws.
 * The ref goes through `forwardRef`, not as a prop: the app runs on Preact (aliased to react), which hands a plain function component its instance instead.
 */
export const Button = forwardRef<HTMLElement, ButtonProps>(function Button({ variant, size, className, ...props }, ref) {
  const classes = cx(base, variants[variant ?? "plain"], sized(size, variant), className);
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- the children arrive in props
  if (props.href !== undefined) return <a {...props} ref={ref as Ref<HTMLAnchorElement>} className={classes} />;
  return <button type="button" {...props} ref={ref as Ref<HTMLButtonElement>} className={classes} />;
});
