// Reading the page: only now that the owner pressed Send, and only the active tab of the last focused browser window.
import type { Page } from "./message.ts";

/** What the panel read from the tab, and each part it could not read. */
export interface Capture {
  page: Page;
  png: Blob | null;
  /** The page does not let scripts run, so its selected text was not read. */
  selectionLost: boolean;
  /** A screenshot was asked for and Chrome did not take it. */
  screenshotLost: boolean;
}

/**
 * captureTab reads the address and title, the selected text and, when asked, a screenshot. The address and title need activeTab,
 * which the click on the Convoz button gave; the selection and screenshot also need the page to allow it, which chrome:// pages,
 * the Web Store and the PDF viewer do not. Throws when there is no tab to read.
 */
export async function captureTab(withScreenshot: boolean): Promise<Capture> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const [tab] = win.id === undefined ? [] : await chrome.tabs.query({ active: true, windowId: win.id });
  if (tab?.id === undefined || !tab.url) throw new Error("This page cannot be captured. Click the Convoz button on the page you want to send.");
  let selection = "";
  let selectionLost = false;
  try {
    const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection()?.toString() ?? "" });
    selection = done?.result ?? "";
  } catch {
    selectionLost = true;
  }
  let png: Blob | null = null;
  let screenshotLost = false;
  if (withScreenshot) {
    try {
      png = await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }))).blob();
    } catch {
      screenshotLost = true;
    }
  }
  return { page: { url: tab.url, title: tab.title ?? "", selection }, png, selectionLost, screenshotLost };
}
