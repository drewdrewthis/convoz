import { splitCallLog } from "./log.ts";

/** CallLogRow is the log of a finished call, closed: one quiet line in the chat; the owner opens it to read what was said and done. */
export function CallLogRow({ body }: { body: string }) {
  const log = splitCallLog(body);
  if (!log) return null;
  return (
    <details className="calllog">
      <summary>{log.summary}</summary>
      <pre>{log.lines}</pre>
    </details>
  );
}
