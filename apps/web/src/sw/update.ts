// Updates wait for the owner: a new worker stays "waiting" until a page asks it to take over.
import type { SwModule } from "./module.ts";

/** Told apart per worker start, so a page can tell which build it runs under. */
const instance = crypto.randomUUID();

const update: SwModule = {
  name: "update",
  install(scope) {
    scope.addEventListener("message", (event) => {
      if (event.data?.type === "skip-waiting") void scope.skipWaiting();
      if (event.data?.type === "instance") event.ports[0]?.postMessage(instance);
    });
  },
};
export default update;
