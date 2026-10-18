import "./app/effects.ts";
import { createRoot } from "react-dom/client";
import { App, prepare } from "./app/App.tsx";
import { route } from "./app/routes.tsx";
import { call, client } from "./shared/api.ts";
import { dropEarly } from "./shared/early.ts";
import { afterFirstScreen, noFirstScreen } from "./shared/perf.ts";
import { registerServiceWorker } from "./sw/index.ts";
import "./styles/app.css";
import "./styles/appearance.css";

const def = route(location.pathname, document.documentElement.dataset.status);
prepare(def);
if (!def.useful) noFirstScreen();
registerServiceWorker();
void def.load().then((Page) => createRoot(document.getElementById("root")!).render(<App def={def} Page={Page} />));
// After the first screen: the saved look and the owner's palette. The boot script already painted what this device had.
void afterFirstScreen()
  .then(() => import("./features/settings/index.ts"))
  .then((f) => f.syncAppearance());
// A page back from the back-forward cache shows what it held when it was left, and a cold page held the owner's first reads inline:
// the session may have ended since (a logout, a revoked device). Ask the server again; a revoking 401 clears the device and opens
// sign in (call), so the held data never stands for a session that is gone.
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  dropEarly();
  void call(client.GET("/api/me")).catch(() => {});
});
