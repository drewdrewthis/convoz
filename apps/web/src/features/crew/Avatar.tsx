import { initials, paletteOf } from "../../shared/chat.ts";
import { LOOK, type Shown } from "./status.ts";

/**
 * Ring is an agent's avatar on Crew: its own picture when it has one (only ever in an img, I-32), else its letter on its tint, inside a ring. With `shown` the ring tells the state too, in words as
 * well as in its look (the accessible name says what the ring is), so colour is never the only signal.
 */
export function Ring({ handle, shown, quiet, avatar }: { handle: string; shown?: Shown; quiet?: boolean; avatar?: string }) {
  const p = `p${paletteOf(handle)}`;
  return (
    <span className={`ring ${p}`} data-st={shown} role={shown && !quiet ? "img" : undefined} aria-label={shown && !quiet ? LOOK[shown].ring : undefined} aria-hidden={(shown && !quiet) || avatar ? undefined : "true"}>
      <span className={`in ${p}`}>{avatar ? <img src={avatar} alt={`@${handle} avatar`} /> : initials(handle)}</span>
    </span>
  );
}
