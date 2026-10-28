// Drawer: the one right-side panel slot of the app shell (?panel=<id> in the address). It shows Now first; details and Work can be
// added as panels (panel.ts, registry.tsx). Mounted by app/App.tsx.
export { DrawerHost } from "./DrawerHost.tsx";
export { openPanel, togglePanel, usePanel, type PanelId } from "./panel.ts";
