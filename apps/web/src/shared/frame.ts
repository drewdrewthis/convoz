// The web app inside the Convoz extension's side panel (page-share.feature): it tells the panel which conversation is open, so
// "Share this tab" shares the tab with it. Only a Chrome extension may frame the app (the server's frame-ancestors names the one the
// owner allows), and the message goes to that origin alone, so no page ever learns what is open.

/** tellPanel says the open conversation to the extension panel that frames the app; null when none is open. Off unless framed. */
export function tellPanel(conversation: { id: number; title: string } | null): void {
  if (window.parent === window) return;
  const panel = location.ancestorOrigins?.[0] ?? "";
  if (!panel.startsWith("chrome-extension://")) return;
  window.parent.postMessage({ type: "convoz:conversation", id: conversation?.id ?? null, title: conversation?.title ?? null }, panel);
}
