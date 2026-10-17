// The look of the app: theme, palette and text size. Theme and text size are the device's own (design §11): they live in
// IndexedDB and never reach the server. The palette is the owner's and follows them to every device. All three are mirrored in
// localStorage because the boot script (/assets/settings/theme-boot.js, owned by the Go settings module) must read them before the first
// paint, and IndexedDB is asynchronous.
import { openCache } from "@convoz/api-client/db";

export const THEMES = ["light", "dark", "system"] as const;
export const PALETTES = ["iris", "ember", "mono", "tide"] as const;
export const TEXT_SIZES = ["s", "m", "l", "xl"] as const;

export type Theme = (typeof THEMES)[number];
export type Palette = (typeof PALETTES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];

export interface Look {
  theme: Theme;
  palette: Palette;
  text_size: TextSize;
}

export const DEFAULT_LOOK: Look = { theme: "system", palette: "iris", text_size: "m" };

/** Same key as the boot script. */
const MIRROR = "convoz.appearance";

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** readMirror is the look the boot script painted. A missing or damaged mirror reads as the defaults. */
export function readMirror(): Look {
  try {
    const s = JSON.parse(localStorage.getItem(MIRROR) ?? "{}") as Partial<Record<keyof Look, unknown>>;
    return { theme: pick(THEMES, s.theme, "system"), palette: pick(PALETTES, s.palette, "iris"), text_size: pick(TEXT_SIZES, s.text_size, "m") };
  } catch {
    return DEFAULT_LOOK;
  }
}

/** applyLook mirrors the look and asks the boot script to repaint, so there is one place that decides what "system" means. */
export function applyLook(look: Look): void {
  try {
    localStorage.setItem(MIRROR, JSON.stringify(look));
  } catch {
    /* storage blocked: the look still applies for this page below */
  }
  window.dispatchEvent(new Event("convoz-appearance"));
}

/** readDevice loads the device's own choices from IndexedDB. Anything missing or unreadable is left out. */
export async function readDevice(): Promise<Partial<Pick<Look, "theme" | "text_size">>> {
  try {
    const db = await openCache();
    const [theme, size] = await Promise.all([db.get("settings", "theme"), db.get("settings", "text_size")]);
    db.close();
    return {
      ...(THEMES.includes(theme as Theme) ? { theme: theme as Theme } : {}),
      ...(TEXT_SIZES.includes(size as TextSize) ? { text_size: size as TextSize } : {}),
    };
  } catch {
    return {};
  }
}

/** writeDevice saves one device choice to IndexedDB. */
export async function writeDevice(key: "theme" | "text_size", value: string): Promise<void> {
  try {
    const db = await openCache();
    await db.put("settings", value, key);
    db.close();
  } catch {
    /* the mirror already holds it for this device */
  }
}
