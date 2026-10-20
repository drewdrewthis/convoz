import type { ReactNode, Ref } from "react";
import { cx } from "@convoz/ui/cx";

/** MenuItem is one row of an ask menu. */
export function MenuItem({ sheet, quiet, onClick, children }: { sheet?: boolean; quiet?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    // eslint-disable-next-line convoz/no-raw-button -- a menu row is not a pill: no atom draws it (a left-aligned 44px row with a soft hover), and only the menus of the ask card use it
    <button
      role="menuitem"
      type="button"
      className={cx(
        "border-0 rounded-[8px] bg-transparent px-14 [font-family:inherit] cursor-pointer hover:bg-soft",
        sheet ? "min-h-48 text-center text-16" : "min-h-44 text-left text-14",
        quiet ? "text-muted" : "text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * AskMenu is a menu of the ask card. It opens in the flow of the card, under the row that opened it, so it covers no button of the card.
 * On a phone (`sheet`) it is a bottom sheet over a scrim, with a Cancel row; the card keeps a gap as tall as the sheet and scrolls up past it.
 */
export function AskMenu({ sheet, holder, shut, children }: { sheet: boolean; holder: Ref<HTMLDivElement>; shut: () => void; children: ReactNode }) {
  if (!sheet)
    return (
      // A zero-height anchor: the menu floats over the card under its button and pushes nothing down (owner, msg 2101).
      <div className="relative z-20 h-0">
        <div className="absolute top-4 right-0 flex min-w-180 flex-col rounded-[12px] border border-solid border-border bg-raised p-4 [box-shadow:var(--float)]" role="menu">
          {children}
        </div>
      </div>
    );
  return (
    <>
      <div className="fixed inset-0 z-50 bg-(--scrim)" onClick={shut} />
      <div
        ref={holder}
        className="fixed inset-x-0 bottom-0 z-[51] m-0 flex flex-col rounded-t-[22px] border-0 border-t border-solid border-border bg-raised px-12 pt-8 pb-[calc(12px+var(--bottom))] [box-shadow:var(--float)]"
        role="menu"
      >
        {children}
        <MenuItem sheet quiet onClick={shut}>
          Cancel
        </MenuItem>
      </div>
    </>
  );
}
