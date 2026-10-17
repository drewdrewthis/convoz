// Whether the search overlay is open. The button, the shortcut and the overlay share it.
import { create } from "zustand";

interface SearchUi {
  open: boolean;
  /** The element that opened it, so closing puts the focus back there. */
  from: HTMLElement | null;
  show(from?: HTMLElement | null): void;
  hide(): void;
}

export const useSearchUi = create<SearchUi>()((set, get) => ({
  open: false,
  from: null,
  show: (from = null) => set({ open: true, from }),
  hide: () => {
    const { from } = get();
    set({ open: false, from: null });
    // after the overlay is gone, so the focus is not taken back by the page that was behind it
    queueMicrotask(() => from?.focus());
  },
}));
