import { initials, paletteOf } from "../../shared/chat.ts";

/** Ring is an agent's avatar on Crew: its letter on its tint inside a ring. */
export function Ring({ handle }: { handle: string }) {
  const p = `p${paletteOf(handle)}`;
  return (
    <span className={`ring ${p}`} aria-hidden="true">
      <span className={`in ${p}`}>{initials(handle)}</span>
    </span>
  );
}
