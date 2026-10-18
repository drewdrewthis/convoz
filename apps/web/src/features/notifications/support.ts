// What this browser can do for push, kept free of imports so a plain node test can run it against a fake browser.

/** The parts of the browser that push needs; the real ones by default. */
export interface PushEnv {
  navigator?: { serviceWorker?: unknown; userAgent?: string; vendor?: string; standalone?: boolean };
  window?: object;
  ServiceWorkerRegistration?: { prototype: object };
  matchMedia?: (query: string) => { matches: boolean };
}

const real = (): PushEnv => globalThis as unknown as PushEnv;

/**
 * Whether this browser can do push at all. iOS puts PushManager on the registration (and, in a Home Screen app, on the window too);
 * so either one counts. In a plain Safari tab on iOS neither exists.
 */
export function pushSupported(env: PushEnv = real()): boolean {
  const hasPushManager = Boolean(env.window && "PushManager" in env.window) || Boolean(env.ServiceWorkerRegistration && "pushManager" in env.ServiceWorkerRegistration.prototype);
  return Boolean(env.navigator && "serviceWorker" in env.navigator) && Boolean(env.window && "Notification" in env.window) && hasPushManager;
}

/** An iPhone or iPad (any browser on it is WebKit). */
export function onIos(env: PushEnv = real()): boolean {
  return /iPhone|iPad|iPod/.test(env.navigator?.userAgent ?? "");
}

/**
 * Chrome on an iPhone. A Home Screen app added from Chrome may report no "CriOS" (and even a desktop UA), but Chrome's vendor is
 * still Google while Safari's is Apple; so the UA token or an iOS UA with a Google vendor counts.
 */
export function isChromeOnIOS(env: PushEnv = real()): boolean {
  return /CriOS/.test(env.navigator?.userAgent ?? "") || (onIos(env) && env.navigator?.vendor === "Google Inc.");
}

/** What Chrome on iPhone is told, for push and for the microphone alike: only a Home Screen app added from Safari gets them. */
export const CHROME_IOS_HINT = "Open Convoz in Safari and add it to the Home Screen from there.";

/** A third-party browser on iOS (Chrome, Firefox, Edge): its Home Screen shortcut is not a Safari web app, so it cannot get push. */
export function onIosThirdPartyBrowser(env: PushEnv = real()): boolean {
  return onIos(env) && /CriOS|FxiOS|EdgiOS|OPiOS/.test(env.navigator?.userAgent ?? "");
}

/**
 * An iPhone or iPad that cannot do push yet: push works only in a Home Screen app added from Safari. The page asks the browser
 * (no PushManager) rather than guessing from the display mode, because a Home Screen app of another browser reports it differently.
 */
export function needsHomeScreen(env: PushEnv = real()): boolean {
  return onIos(env) && !pushSupported(env);
}
