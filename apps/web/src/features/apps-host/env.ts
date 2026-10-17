// What the host tells an app about the device, and how it judges the link. Read at the moment of use, never cached.

interface NetworkInfo {
  saveData?: boolean;
  effectiveType?: string;
}
const connection = (): NetworkInfo | undefined => (navigator as Navigator & { connection?: NetworkInfo }).connection;

/** A Save-Data or slow link (2g, 3g): previews that cost bytes wait for a tap (design §12.3). */
export const slowLink = (): boolean => {
  const c = connection();
  return Boolean(c?.saveData) || ["slow-2g", "2g", "3g"].includes(c?.effectiveType ?? "");
};
export const saveData = (): boolean => Boolean(connection()?.saveData);

/** "61 KB" for 61440 bytes: decimal kilobytes, as the preview card shows them. */
export function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The bytes of a value as JSON, the size a stub names. */
export const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

const TOKENS: Record<string, string> = {
  bg: "--color-bg",
  raised: "--color-raised",
  text: "--color-text",
  muted: "--color-muted",
  line: "--color-border",
  accent: "--color-accent",
  onAccent: "--color-on-accent",
  good: "--color-success",
  warn: "--color-warning",
  bad: "--color-danger",
};

/** hex turns any CSS colour (oklch, rgb, a name) into #rrggbb through a one-pixel canvas. */
function hex(css: string): string {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return "#000000";
  ctx.fillStyle = "#000000";
  ctx.fillStyle = css;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export interface FrameEnv {
  theme: "light" | "dark";
  tokens: Record<string, string>;
  locale: string;
  reducedMotion: boolean;
  saveData: boolean;
  platform: "phone" | "desktop";
  width: number;
}

/** frameEnv is the env of the bridge `init`: the theme, ten colours as #rrggbb, and the device facts. */
export function frameEnv(width: number): FrameEnv {
  const root = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, hex(root.getPropertyValue(v).trim() || "#000000")]));
  const attr = document.documentElement.dataset.theme;
  const dark = attr ? attr === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const locale = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(navigator.language) ? navigator.language : "en";
  return {
    theme: dark ? "dark" : "light",
    tokens,
    locale,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    saveData: saveData(),
    platform: matchMedia("(max-width: 600px)").matches ? "phone" : "desktop",
    width: Math.max(1, Math.round(width)),
  };
}
