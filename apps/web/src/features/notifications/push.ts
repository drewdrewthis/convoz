// The browser side of push: the permission flow, the subscription, and the reports of where the device looks.
import { call, client } from "../../shared/api.ts";

const FLAG = "convoz.push";

/** Whether this browser can do push at all. */
export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** An iPhone or iPad browser that is not an installed Home Screen app: push works only after "Add to Home Screen". */
export function needsHomeScreen(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
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

/** Ask for permission, subscribe with the server's key and tell the server. Throws a sentence when the owner says no. */
export async function turnOn(): Promise<void> {
  if (Notification.permission === "denied") throw new Error("Notifications are blocked for this site. Allow them in the browser settings.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were not allowed.");
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await call(client.GET("/api/push/vapid-key"));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }));
  const json = sub.toJSON();
  await call(client.POST("/api/push/subscriptions", { body: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } } }));
  remember(true);
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
