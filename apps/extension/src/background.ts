// The worker only opens the panel. It does so from onClicked rather than with openPanelOnActionClick: in Chromium 1243 only a
// click that reaches onClicked grants activeTab on the page, and the panel needs that grant to read the page at Send.
chrome.action.onClicked.addListener((tab) => void chrome.sidePanel.open({ windowId: tab.windowId }));
