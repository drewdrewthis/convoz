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
export const AttachIcon = icon(<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />);
export const MicIcon = icon(<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3" />);
export const PhoneIcon = icon(<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />);
export const FileIcon = icon(<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />);
export const CloseIcon = icon(<path d="M18 6L6 18M6 6l12 12" />);
export const ReplyIcon = icon(<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 5 5v6" />);
export const ArrowIcon = icon(<path d="M5 12h14M13 6l6 6-6 6" />);
export const ChevronIcon = icon(<path d="M9 6l6 6-6 6" />);
/** PlayIcon and PauseIcon are filled shapes: their wrapper sets fill to currentColor. */
export const PlayIcon = icon(<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />);
export const PauseIcon = icon(
  <>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </>,
);
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
/** Waiting on you: a raised hand (plan status, Conversations rows). */
export const HandIcon = icon(<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 8 8h1a7 7 0 0 0 7-7v-3a2 2 0 0 0-4 0" />);
/** Blocked: an alert. */
export const AlertIcon = icon(<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />);
/** Late or not responding: a clock. */
export const ClockIcon = icon(<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2" />);
/** Deliveries: a calendar (a clock means Late on the rows). */
export const DeliveryIcon = icon(<path d="M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18" />);
export const DownloadIcon = icon(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />);
