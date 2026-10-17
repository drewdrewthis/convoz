import { initials, paletteOf } from "../../shared/chat.ts";
import { LOOK, type Shown } from "./status.ts";

/**
 * Ring is an agent's avatar on Crew: its letter on its tint inside a ring. With `shown` the ring tells the state too, in words as
 * well as in its look (the accessible name says what the ring is), so colour is never the only signal.
 */
export function Ring({ handle, shown, quiet }: { handle: string; shown?: Shown; quiet?: boolean }) {
  const p = `p${paletteOf(handle)}`;
  return (
    <span className={`ring ${p}`} data-st={shown} role={shown && !quiet ? "img" : undefined} aria-label={shown && !quiet ? LOOK[shown].ring : undefined} aria-hidden={shown && !quiet ? undefined : "true"}>
      <span className={`in ${p}`}>{initials(handle)}</span>
    </span>
  );
}
