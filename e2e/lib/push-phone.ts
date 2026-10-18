import type { BrowserContext } from "@playwright/test";
import { newSub, subBody, type Sub } from "./push-wp14.ts";

interface Fake {
  endpoint: string;
  p256dh: string;
  auth: string;
  neverReady: boolean;
  permission: string;
  supported: boolean;
}

/**
 * Give every page of the context a phone's push: a PushManager that hands out one subscription to the fake push service (a real key
 * pair, so a test can decrypt what the server sends) and a permission prompt that takes a moment and answers "granted".
 * `permission` is what the browser says before the prompt; `supported: false` takes push away (a browser that cannot do it).
 */
export async function installFakePhone(context: BrowserContext, o: { neverReady?: boolean; permission?: "default" | "granted" | "denied"; supported?: boolean } = {}): Promise<Sub> {
  const sub = newSub();
  const fake: Fake = { endpoint: sub.endpoint, ...subBody(sub).keys, neverReady: o.neverReady ?? false, permission: o.permission ?? "default", supported: o.supported ?? true };
  await context.addInitScript((f: Fake) => {
    if (!f.supported) {
      delete (ServiceWorkerRegistration.prototype as { pushManager?: unknown }).pushManager;
      delete (window as { PushManager?: unknown }).PushManager;
      return;
    }
    let held: unknown = null;
    const made = { endpoint: f.endpoint, toJSON: () => ({ endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } }) };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      configurable: true,
      get: () => ({ getSubscription: async () => held, subscribe: async () => (held = made) }),
    });
    // The prompt takes a moment, as it does on a phone.
    let permission = f.permission;
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
    Notification.requestPermission = async () => {
      await new Promise((r) => setTimeout(r, 700));
      return (permission = "granted") as NotificationPermission;
    };
    if (f.neverReady) Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, get: () => new Promise(() => {}) });
  }, fake);
  return sub;
}
