// A place in the event log: "<epoch>:<seq>" (design §5.4, §5.5). The epoch changes when the log is rebuilt or restored, so
// a cursor from another log is never mistaken for a place in this one.
export interface Cursor {
  epoch: string;
  seq: number;
}

/** parseCursor reads "1:57"; anything else is null. */
export function parseCursor(text: string | null | undefined): Cursor | null {
  const m = /^([^:\s]+):(\d+)$/.exec(String(text ?? ""));
  return m ? { epoch: m[1]!, seq: Number(m[2]) } : null;
}

export const formatCursor = (c: Cursor): string => `${c.epoch}:${c.seq}`;
