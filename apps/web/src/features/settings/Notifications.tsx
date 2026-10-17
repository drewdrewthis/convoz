/** True on an iPhone or iPad (iPadOS says "Mac" but has touch points). Push there works only from the installed app. */
const onIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** True when the page runs from the Home Screen icon rather than a browser tab. */
const installed = (): boolean => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Notifications is Settings → Notifications. On an iPhone in a browser tab it explains how to install the app first (design §10). */
export function Notifications() {
  const guide = onIos() && !installed();
  return (
    <>
      <h2>Notifications</h2>
      {guide ? (
        <section className="group" aria-label="Add to Home Screen">
          <div className="row stacked">
            <strong>Add Convoz to your Home Screen</strong>
            <span className="sub">On iPhone, push works only from the installed app. In Safari tap Share → Add to Home Screen, then open Convoz from its icon and turn push on here.</span>
          </div>
        </section>
      ) : (
        <p className="sub">Nothing to set up on this device yet.</p>
      )}
    </>
  );
}
