import { useEffect } from "react";
import { pushRemembered, reportFocus } from "./push.ts";

/** How often a focused device repeats its report; the server forgets it after 90 s. */
const EVERY_MS = 30_000;

/**
 * useFocusReport tells the server this device has the conversation open and focused, while it does, so no push is sent for what
 * the owner is already reading. It does nothing on a device that never turned push on.
 */
export function useFocusReport(conversationId: number | undefined): void {
  useEffect(() => {
    if (!conversationId || !pushRemembered()) return;
    const report = () => reportFocus(document.visibilityState === "visible" && document.hasFocus() ? conversationId : null);
    report();
    const timer = setInterval(report, EVERY_MS);
    addEventListener("focus", report);
    addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", report);
      removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
      reportFocus(null);
    };
  }, [conversationId]);
}
