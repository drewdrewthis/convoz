// Every story renders over the design tokens, as in the app: the page is a landmark on the surface colour with the text colour.
import type { GlobalProvider } from "@ladle/react";
import "@convoz/tokens/tokens.css";

export const Provider: GlobalProvider = ({ children }) => (
  <main style={{ background: "var(--cv-surface)", color: "var(--cv-text)", minHeight: "100vh", padding: 16, boxSizing: "border-box" }}>{children}</main>
);
