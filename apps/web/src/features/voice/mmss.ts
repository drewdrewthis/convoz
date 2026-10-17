/** mmss writes a length in whole seconds as m:ss ("0:07"). */
export const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
