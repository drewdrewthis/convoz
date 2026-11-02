// The web app inside the Convoz extension's side panel (page-share.feature): it tells the panel which conversation is open, and
// "Share this tab" in that conversation's header asks the panel to share the tab with it. Only a Chrome extension may frame the app
// (the server's frame-ancestors names the one the owner allows), and each message goes to that origin alone, so no page ever learns
// what is open.

/** panelOrigin is the origin of the extension panel that frames the app; "" when the app is not in one. */
function panelOrigin(): string {
  if (window.parent === window) return "";
  const panel = location.ancestorOrigins?.[0] ?? "";
  return panel.startsWith("chrome-extension://") ? panel : "";
}

/** inPanel is true when the app runs in the extension's side panel, which can share a browser tab. */
export const inPanel = (): boolean => panelOrigin() !== "";

/** tellPanel says the open conversation to the extension panel that frames the app; null when none is open. Off unless framed. */
export function tellPanel(conversation: { id: number; title: string } | null): void {
  const panel = panelOrigin();
  if (!panel) return;
  window.parent.postMessage({ type: "convoz:conversation", id: conversation?.id ?? null, title: conversation?.title ?? null }, panel);
}

/** askPanelToShare asks the panel to share the tab the owner is on with the conversation; the panel asks what to look at. */
export function askPanelToShare(conversation: number): void {
  const panel = panelOrigin();
  if (panel) window.parent.postMessage({ type: "convoz:share", id: conversation }, panel);
}
