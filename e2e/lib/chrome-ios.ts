import type { BrowserContext } from "@playwright/test";

const CHROME_IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";

export interface FakeBrowser {
  /** Say the browser is Chrome on an iPhone. */
  chromeIos?: boolean;
  /** Take away the microphone API and MediaRecorder. */
  noRecorderApi?: boolean;
  /** Keep the API but make the microphone prompt answer "NotAllowedError". */
  micDenied?: boolean;
}

/** Give every page of the context the browser the owner described; run it before the first goto. */
export async function installFakeBrowser(context: BrowserContext, o: FakeBrowser): Promise<void> {
  await context.addInitScript(
    (f: FakeBrowser & { ua: string }) => {
      if (f.chromeIos) {
        Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => f.ua });
        Object.defineProperty(navigator, "vendor", { configurable: true, get: () => "Google Inc." });
      }
      if (f.noRecorderApi) {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => undefined });
        delete (window as { MediaRecorder?: unknown }).MediaRecorder;
      }
      if (f.micDenied) {
        const denied = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => ({ getUserMedia: denied }) });
      }
    },
    { ...o, ua: CHROME_IOS_UA },
  );
}
