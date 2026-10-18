// The browser side of push: the permission flow, the subscription, and the reports of where the device looks.
import { ApiError, call, client, humanError } from "../../shared/api.ts";
import { ensureServiceWorker } from "../../sw/index.ts";
import { needsHomeScreen, pushSupported } from "./support.ts";

const FLAG = "convoz.push";

export { needsHomeScreen, onIosThirdPartyBrowser, pushSupported } from "./support.ts";

/** How long the page waits for the worker before it says so. */
export const WORKER_WAIT_MS = 10_000;

/** What this device shows in Settings: push on, off, blocked in the browser, or not possible until the app is on the Home Screen. */
export type DeviceState = "on" | "off" | "blocked" | "needs-home-screen" | "unsupported";

/** deviceState reads the state of this device; `subscribed` is whether the server lists an active subscription for it. */
export function deviceState(subscribed: boolean): DeviceState {
  if (needsHomeScreen()) return "needs-home-screen";
  if (!pushSupported()) return "unsupported";
  if (subscribed) return "on";
  return Notification.permission === "denied" ? "blocked" : "off";
}

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* private mode: the page just does not report focus */
  }
}

/** Push was turned on from this device. */
export function pushRemembered(): boolean {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The subscription this browser holds, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** A failure of turning push on that already names its step; the page shows it as it is. */
export class PushStepError extends Error {}

/** Run one step of turning push on; a failure names the step in one sentence. */
async function step<T>(failed: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    // humanError speaks of passkeys for a browser refusal, so only the server's own errors go through it.
    const why = err instanceof ApiError ? humanError(err) : err instanceof Error ? err.message || err.name : "";
    throw new PushStepError(`${failed}${why ? ` ${why}` : ""}`);
  }
}

/** The worker that will receive pushes, ready; registered here when nothing did it yet. Gives up after WORKER_WAIT_MS. */
function workerReady(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The app's background worker did not start within 10 seconds. Close Convoz, open it again and retry.")), WORKER_WAIT_MS);
  });
  const ready = ensureServiceWorker().then(() => navigator.serviceWorker.ready);
  return Promise.race([ready, late]).finally(() => clearTimeout(timer));
}

/**
 * Ask for permission, subscribe with the server's key and tell the server, which then sends the "Notifications are on" push.
 * `progress` gets a sentence before each step. The permission prompt is the first await: iOS needs it inside the tap.
 * Throws one sentence naming the step that failed.
 */
export async function turnOn(progress: (text: string) => void = () => undefined): Promise<void> {
  if (Notification.permission === "denied") throw new PushStepError("Notifications are blocked for this site. Allow them in the device settings.");
  progress("Asking iPhone for permission…");
  const answer = await step("Asking for permission failed:", () => Notification.requestPermission());
  if (answer !== "granted") throw new PushStepError("Notifications were not allowed.");
  progress("Starting the background worker…");
  const reg = await step("Starting the background worker failed:", workerReady);
  progress("Signing up this device…");
  const sub = await step("Signing up this device failed:", async () => {
    const { public_key } = await call(client.GET("/api/push/vapid-key"));
    return (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }));
  });
  const json = sub.toJSON();
  await step("Telling Convoz about this device failed:", () =>
    call(client.POST("/api/push/subscriptions", { body: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } } })),
  );
  remember(true);
  progress("Sending a confirmation…");
  // The confirmation is a courtesy: the device is signed up, so a failure here is not an error of turning on.
  await call(client.POST("/api/push/test")).catch(() => undefined);
}

/** Turn push off on this device: the server forgets it, then the browser drops it. */
export async function turnOff(): Promise<void> {
  await client.DELETE("/api/push/subscriptions");
  await (await currentSubscription())?.unsubscribe();
  remember(false);
}

/** Tell the server which conversation this device looks at (null for none), so a push for it is held back. */
export function reportFocus(conversationId: number | null): void {
  void client.PUT("/api/push/focus", { body: { conversation_id: conversationId } }).catch(() => undefined);
}
