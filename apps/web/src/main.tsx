import { createRoot } from "react-dom/client";
import { App, prepare } from "./app/App.tsx";
import { route } from "./app/routes.tsx";
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
