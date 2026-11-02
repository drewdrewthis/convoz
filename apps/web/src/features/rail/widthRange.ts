export const RAIL_MIN = 200;
export const RAIL_MAX = 480;
export const RAIL_DEFAULT = 240;

/** clampWidth keeps a sidebar width inside the range that leaves the page usable. */
export const clampWidth = (n: number): number => Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(n)));

/** parseWidth reads a stored width: no number means the default, any other is clamped. */
export const parseWidth = (stored: string | null): number => {
  const n = Number(stored);
  return n ? clampWidth(n) : RAIL_DEFAULT;
};
