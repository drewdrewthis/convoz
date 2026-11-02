import { Icon, REPLY_D, SNOOZE_D } from "@convoz/app-kit";
import { TickIcon } from "@convoz/ui/icons";

/** The icons of the three actions of an item, the ones the main Now already draws: Reply and Snooze are the ask card's Quick reply bubble and Snooze clock (app-kit AskActions); Okay is the check of Now's all-clear Tick (ui icons). */
export const ReplyGlyph = () => <Icon d={REPLY_D} />;
export const SnoozeGlyph = () => <Icon d={SNOOZE_D} />;
export const OkayGlyph = () => (
  <span aria-hidden="true" className="inline-flex [&_svg]:size-18 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:2]">
    <TickIcon />
  </span>
);
