// Settings' state: the look in use. Choosing applies at once; the palette is also saved to the server.
import { create } from "zustand";
import { call, client, page } from "../../shared/api.ts";
import { applyLook, readDevice, readMirror, writeDevice, type Look, type Palette } from "./appearance.ts";

interface SettingsState extends Look {
  /** choose applies one choice now and saves it where it belongs (the device, or the server for the palette). */
  choose<K extends keyof Look>(key: K, value: Look[K]): Promise<void>;
  /** hydrate reads the device's IndexedDB and the server's palette, then applies them. Offline, the mirror stands. */
  hydrate(): Promise<void>;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  ...readMirror(),
  choose: async <K extends keyof Look>(key: K, value: Look[K]) => {
    set({ [key]: value } as Pick<Look, K>);
    const { theme, palette, text_size } = get();
    applyLook({ theme, palette, text_size });
    if (key === "palette") {
      await call(client.PATCH("/api/settings", { body: { scope: "user", key: "palette", value } }));
    } else {
      await writeDevice(key, value);
    }
  },
  hydrate: async () => {
    const device = await readDevice();
    let palette: Palette = get().palette;
    if (!page.public) {
      try {
        const entry = (await call(client.GET("/api/settings"))).settings.find((s) => s.key === "palette");
        if (typeof entry?.value === "string") palette = entry.value as Palette;
      } catch {
        /* offline or signed out: keep the cached palette */
      }
    }
    set({ ...device, palette });
    const { theme, text_size } = get();
    applyLook({ theme, palette, text_size });
  },
}));
