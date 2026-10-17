// The app's line icons (prototype v41). Each is decorative (aria-hidden); the control around it carries the name.
import type { ReactNode } from "react";

const icon = (paths: ReactNode) => () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {paths}
  </svg>
);

export const BackIcon = icon(<path d="M15 18l-6-6 6-6" />);
export const AccountIcon = icon(
  <>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M4.6 20c.7-3.7 3.9-5.6 7.4-5.6s6.7 1.9 7.4 5.6" />
  </>,
);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const NowIcon = icon(<path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />);
export const ChatIcon = icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const CrewIcon = icon(<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />);
export const DetailsIcon = icon(<path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 3v18" />);
export const SendIcon = icon(<path d="M12 19V6M6 11.5l6-6 6 6" />);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </>,
);
export const MachineIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);

/** TickIcon has no aria-hidden of its own: its wrapper hides it. */
export const TickIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
