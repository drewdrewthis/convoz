// The worker opens the panel, and ends the panel's share when the panel closes.
import { Convoz } from "./api.ts";

// From onClicked rather than with openPanelOnActionClick: in Chromium 1243 only a click that reaches onClicked grants activeTab on
// the page, and a screenshot of a shared tab needs that grant.
chrome.action.onClicked.addListener((tab) => void chrome.sidePanel.open({ windowId: tab.windowId }));

// Each panel holds a port and says which share it runs. A closed panel can no longer say Stop, so its port closing ends the share;
// the server's 45 s heartbeat is the backstop when even this does not run.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  let live: { server: string; share: string } | null = null;
  port.onMessage.addListener((message) => {
    const m = message as { server?: unknown; share?: unknown };
    live = typeof m.server === "string" && typeof m.share === "string" ? { server: m.server, share: m.share } : null;
  });
  port.onDisconnect.addListener(() => {
    if (live) void new Convoz(live.server).stopShare(live.share).catch(() => {});
  });
});
