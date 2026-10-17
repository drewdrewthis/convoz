import { initials, paletteOf } from "../../shared/chat.ts";

/** Ring is an agent's avatar on Crew: its own picture when it has one (only ever in an img, I-32), else its letter on its tint, inside a ring. */
export function Ring({ handle, avatar }: { handle: string; avatar?: string }) {
  const p = `p${paletteOf(handle)}`;
  return (
    <span className={`ring ${p}`} aria-hidden={avatar ? undefined : "true"}>
      <span className={`in ${p}`}>{avatar ? <img src={avatar} alt={`@${handle} avatar`} /> : initials(handle)}</span>
    </span>
  );
}
