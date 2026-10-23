import { forwardRef, type ComponentPropsWithoutRef } from "react";

/**
 * MenuItem is one row of a menu (`role="menu"`): a plain `<button role="menuitem">` with no styles of its own, so the menu that holds it
 * draws every row the same (the message menu styles `.msg-menu button`). The ref goes through `forwardRef` for the same Preact reason as Button.
 */
export const MenuItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(function MenuItem(props, ref) {
  return <button type="button" role="menuitem" {...props} ref={ref} />;
});
