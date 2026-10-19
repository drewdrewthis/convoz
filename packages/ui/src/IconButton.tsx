import { forwardRef, type ComponentPropsWithoutRef, type Ref } from "react";
import { cx } from "./cx.ts";

export type IconButtonVariant = "quiet" | "muted" | "dim" | "plain" | "bordered" | "float" | "primary" | "send" | "soft";
export type IconButtonSize = 28 | 32 | 36 | 44;
/** The icon's size in px, drawn as a line icon. "self": the icon sizes and strokes itself (its own width, height and stroke attributes). */
export type IconButtonGlyph = 12 | 16 | 18 | 20 | 22 | "self";

interface Own {
  /** The name of the button: it is the `aria-label` and, unless `title` is set, the hover title. */
  label: string;
  /** quiet: accent icon, tinted on hover. muted: grey icon. dim: grey icon, half faded, tinted on hover. plain: text-colour icon, tinted on hover. bordered: raised with an edge. float: raised with a shadow, over scrolling content. primary: accent disc. send: accent disc that turns soft when disabled. soft: soft accent disc. */
  variant?: IconButtonVariant;
  /** Width and height in px. Left out: 44, the touch size. */
  size?: IconButtonSize;
  /** Left out: 22. */
  glyph?: IconButtonGlyph;
  /** The line width of the icon, in px of its 24px grid. Left out: 2.2. */
  stroke?: 2 | 2.2;
}

/** A link looking like an icon button is an `<a>` (give it `href`); anything else is a `<button>` that does not submit unless `type="submit"`. */
export type IconButtonProps = Own & ({ href?: undefined } & Omit<ComponentPropsWithoutRef<"button">, "aria-label"> | { href: string } & Omit<ComponentPropsWithoutRef<"a">, "aria-label">);

const tint = "hover:bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)]";
const flat = "border-0";

const variants: Record<IconButtonVariant, string> = {
  quiet: cx(flat, "bg-transparent text-accent-text", tint),
  muted: cx(flat, "bg-transparent text-muted"),
  dim: cx(flat, "bg-transparent text-muted opacity-50", tint),
  plain: cx(flat, "bg-transparent text-text", tint),
  bordered: "border border-solid border-border bg-raised text-text",
  float: cx(flat, "pointer-events-auto relative bg-raised text-text [box-shadow:var(--float)]"),
  primary: cx(flat, "bg-accent text-on-accent disabled:opacity-60"),
  send: cx(flat, "bg-accent text-on-accent disabled:bg-selection disabled:text-accent-text"),
  soft: cx(flat, "bg-selection text-accent-text"),
};

const sizes: Record<IconButtonSize, string> = { 28: "size-28", 32: "size-32", 36: "size-36", 44: "size-44" };

const line = "[&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]";
const glyphs: Record<Exclude<IconButtonGlyph, "self">, string> = {
  12: "[&_svg]:size-12",
  16: "[&_svg]:size-16",
  18: "[&_svg]:size-18",
  20: "[&_svg]:size-20",
  22: "[&_svg]:size-22",
};
const strokes = { 2: "[&_svg]:[stroke-width:2]", 2.2: "[&_svg]:[stroke-width:2.2]" } as const;

// The button resets what the browser styles itself (border, padding, background), so it looks the same in the app and in the story book.
const base = "box-border flex flex-none items-center justify-center p-0 rounded-full no-underline cursor-pointer disabled:cursor-default";

/**
 * IconButton is the app's one icon-only button. Its icon is the child; `label` names it. It forwards its ref and every other prop to the `<button>` or `<a>` it draws.
 * The ref goes through `forwardRef`, not as a prop: the app runs on Preact (aliased to react), which hands a plain function component its instance instead.
 */
export const IconButton = forwardRef<HTMLElement, IconButtonProps>(function IconButton({ label, variant = "quiet", size = 44, glyph = 22, stroke = 2.2, className, ...props }, ref) {
  const classes = cx(base, variants[variant], sizes[size], glyph !== "self" && cx(line, glyphs[glyph], strokes[stroke]), className);
  const named = { "aria-label": label, title: props.title ?? label };
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- the icon arrives in props
  if (props.href !== undefined) return <a {...props} {...named} ref={ref as Ref<HTMLAnchorElement>} className={classes} />;
  return <button type="button" {...props} {...named} ref={ref as Ref<HTMLButtonElement>} className={classes} />;
});
