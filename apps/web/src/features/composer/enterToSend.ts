import { isPhone } from "../../shared/api.ts";

/**
 * The device setting "enter to send" (design §11): where the device keeps it, as "auto", "on" or "off". A device setting lives
 * on the device and is not synced; the settings screen writes this key and the composer reads it at each key press.
 */
export const ENTER_TO_SEND_KEY = "convoz.device.enter_to_send";

export type EnterToSend = "auto" | "on" | "off";

/** enterToSend is the setting as stored; anything else, or a store that cannot be read, is "auto". */
export function enterToSend(): EnterToSend {
  try {
    const v = localStorage.getItem(ENTER_TO_SEND_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

/**
 * enterSends says what Enter does in the message box right now: "on" sends, "off" adds a line, and "auto" sends when the device has a
 * hardware keyboard and adds a line when it has only a touch keyboard (a coarse pointer or a narrow screen).
 */
export function enterSends(): boolean {
  const setting = enterToSend();
  return setting === "auto" ? !isPhone() : setting === "on";
}
