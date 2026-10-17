import { useSettings } from "./store.ts";

/** syncAppearance applies this device's saved look and the owner's palette from the server. The app calls it once after it starts. */
export const syncAppearance = (): Promise<void> => useSettings.getState().hydrate();
