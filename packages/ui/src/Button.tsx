import { forwardRef, type ComponentPropsWithoutRef, type Ref } from "react";
import { cx } from "./cx.ts";

export type ButtonVariant = "primary" | "quiet" | "danger";

interface Own {
  /** primary: the accent gradient, the one action of a screen. quiet: text only. danger: a destructive action. Left out: the plain raised pill. */
  variant?: ButtonVariant;
  /** small: as wide as its label, 44px tall. Left out: the full width of its container. */
  size?: "small";
}

/** A link looking like a button is an `<a>` (give it `href`); anything else is a `<button>` that does not submit unless `type="submit"`. */
export type ButtonProps = Own & ({ href?: undefined } & ComponentPropsWithoutRef<"button"> | { href: string } & ComponentPropsWithoutRef<"a">);

// The button resets what the browser styles itself (font, margin, border, background), so it looks the same in the app and in the story book.
const base =
  "box-border inline-flex items-center justify-center gap-8 border border-solid " +
  "rounded-full text-center no-underline cursor-pointer font-semibold [font-family:inherit] " +
  "[transition:transform_140ms_ease,opacity_140ms_ease] [&:active:not(:disabled)]:[transform:scale(.98)] " +
  "disabled:opacity-45 disabled:cursor-default aria-busy:opacity-70";

const variants: Record<ButtonVariant | "plain", string> = {
  plain: "border-border bg-raised text-text",
  primary: "bg-transparent bg-(image:--grad) border-transparent text-on-accent",
  quiet: "bg-transparent border-transparent text-accent-text",
  danger: "border-border bg-raised text-danger",
};

/**
 * Button is the app's one pill button. It forwards its ref and every other prop to the `<button>` or `<a>` it draws.
 * The ref goes through `forwardRef`, not as a prop: the app runs on Preact (aliased to react), which hands a plain function component its instance instead.
 */
export const Button = forwardRef<HTMLElement, ButtonProps>(function Button({ variant, size, className, ...props }, ref) {
  const sized = size === "small" ? "w-auto min-h-44 px-16 text-14" : cx("w-full px-22 text-15", variant === "quiet" ? "min-h-48" : "min-h-50");
  const classes = cx(base, variants[variant ?? "plain"], sized, className);
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- the children arrive in props
  if (props.href !== undefined) return <a {...props} ref={ref as Ref<HTMLAnchorElement>} className={classes} />;
  return <button type="button" {...props} ref={ref as Ref<HTMLButtonElement>} className={classes} />;
});
