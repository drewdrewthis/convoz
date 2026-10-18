// Updates wait for the owner: a new worker stays "waiting" until a page asks it to take over.
import type { SwModule } from "./module.ts";

const update: SwModule = {
  name: "update",
  install(scope) {
    scope.addEventListener("message", (event) => {
      if (event.data?.type === "skip-waiting") void scope.skipWaiting();
    });
  },
};
export default update;
