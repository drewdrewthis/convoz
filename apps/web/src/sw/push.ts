// Push in the worker: show what the server sent, and open the right page when it is tapped (design §10.3).
import type { SwModule } from "./module.ts";
import { pagePath } from "../shared/pagePath.ts";
import { pushOptions, type PushPayload } from "../shared/pushOptions.ts";

function read(event: PushEvent): PushPayload {
  try {
    return (event.data?.json() ?? {}) as PushPayload;
  } catch {
    return {};
  }
}

const push: SwModule = {
  name: "push",
  install(scope) {
    scope.addEventListener("push", (event) => {
      const p = read(event);
      const nav = scope.navigator as WorkerNavigator & { setAppBadge?: (n: number) => Promise<void> };
      const work = [
        scope.registration.showNotification(p.title || "Convoz", pushOptions(p)),
      ];
      if (typeof p.badge === "number" && nav.setAppBadge) work.push(nav.setAppBadge(p.badge).catch(() => undefined) as Promise<void>);
      event.waitUntil(Promise.all(work));
    });

    scope.addEventListener("notificationclick", (event) => {
      event.notification.close();
      const url = new URL(pagePath((event.notification.data as { url?: string } | null)?.url), scope.location.origin).href;
      event.waitUntil(
        (async () => {
          const open = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
          const mine = open.find((c) => new URL(c.url).origin === scope.location.origin);
          if (mine) {
            await mine.focus();
            await mine.navigate(url);
            return;
          }
          await scope.clients.openWindow(url);
        })(),
      );
    });
  },
};

export default push;
