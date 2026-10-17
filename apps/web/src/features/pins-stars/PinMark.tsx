import { PinGlyph } from "../rail/index.ts";

/** PinMark is the small pin beside a message the owner pinned. */
export function PinMark() {
  return (
    <span className="pinmark" role="img" aria-label="Pinned">
      <PinGlyph size={13} />
    </span>
  );
}
