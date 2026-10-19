// Every story renders over the design tokens, as in the app: the page is a landmark on the surface colour with the text colour.
import type { GlobalProvider } from "@ladle/react";
import "@convoz/tokens/tokens.css";
import "./ladle.css";

export const Provider: GlobalProvider = ({ children }) => (
  <main className="box-border min-h-screen bg-(--cv-surface) p-16 text-(--cv-text)">{children}</main>
);
