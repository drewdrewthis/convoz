// Every story renders over the design tokens, as in the app.
import type { GlobalProvider } from "@ladle/react";
import "@convoz/tokens/tokens.css";

export const Provider: GlobalProvider = ({ children }) => <>{children}</>;
