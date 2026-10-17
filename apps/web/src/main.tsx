import { createRoot } from "react-dom/client";
import { App, prepare } from "./app/App.tsx";
import { route } from "./app/routes.tsx";
import { registerServiceWorker } from "./sw/index.ts";
import "./styles/app.css";

const def = route(location.pathname, document.documentElement.dataset.status);
prepare(def);
registerServiceWorker();
void def.load().then((Page) => createRoot(document.getElementById("root")!).render(<App def={def} Page={Page} />));
