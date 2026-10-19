// Every story renders over the design tokens, as in the app: the page is a landmark on the surface colour with the text colour.
import type { GlobalProvider } from "@ladle/react";
import { useEffect } from "react";
import "@convoz/tokens/tokens.css";
import "./ladle.css";

// The story book switches theme with `data-theme` (the --cv-* tokens), but the atoms read --color-*, which the app switches with
// `data-mode`. Without this mirror a dark story drew light-mode text on the dark surface.
function mirrorThemeToMode(): () => void {
  const root = document.documentElement;
  const copy = () => {
    const theme = root.getAttribute("data-theme");
    if (theme) root.setAttribute("data-mode", theme);
  };
  copy();
  const watch = new MutationObserver(copy);
  watch.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  return () => watch.disconnect();
}

export const Provider: GlobalProvider = ({ children }) => {
  useEffect(mirrorThemeToMode, []);
  return <main className="box-border min-h-screen bg-(--cv-surface) p-16 text-(--cv-text)">{children}</main>;
};
