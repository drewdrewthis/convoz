import { TickIcon } from "@convoz/ui/icons";

/** Tick is the accent disc with a check that starts the all-clear line and "No decisions waiting". */
export function Tick() {
  return (
    <span
      aria-hidden="true"
      className="flex size-28 flex-none items-center justify-center rounded-full bg-soft text-accent-text [&_svg]:size-14 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:2.4]"
    >
      <TickIcon />
    </span>
  );
}
