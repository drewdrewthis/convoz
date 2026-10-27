// The rail's own small icons (prototype v41); the shared set stays as it is.
const svg = (children: React.ReactNode, fill = "none", size = 14, width = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const StarIcon = ({ filled = false, size = 14 }: { filled?: boolean; size?: number }) =>
  svg(<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />, filled ? "currentColor" : "none", size);
export const DotsIcon = () => svg(<path d="M12 5h.01M12 12h.01M12 19h.01" />, "none", 16, 3);
export const GripIcon = () => svg(<path d="M4 8h16M4 12h16M4 16h16" />, "none", 14);
export const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "none" }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
/** Chevrons pointing in when the button folds the threads away, out when it shows them. */
export const FoldAllGlyph = ({ folding }: { folding: boolean }) =>
  svg(folding ? <path d="M7 4l5 5 5-5M7 20l5-5 5 5" /> : <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />, "none", 14);
export const BackArrow = () => svg(<path d="M15 18l-6-6 6-6" />, "none", 18, 2.2);
export const ForwardArrow = () => svg(<path d="M9 18l6-6-6-6" />, "none", 18, 2.2);
export const SearchGlyph = () => svg(<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />);
export const ComposeGlyph = () => svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />);
export const NowGlyph = () => svg(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /></>, "none", 14, 1.8);
export const CrewGlyph = () => svg(<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />, "none", 14, 1.8);
export const PinGlyph = ({ size = 14 }: { size?: number }) =>
  svg(<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />, "none", size);
export const InviteGlyph = () => svg(<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" />, "none", 14);
export const PanelGlyph = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>, "none", 16, 1.8);
