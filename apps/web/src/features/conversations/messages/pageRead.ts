// What the owner sees of an agent's read of the shared tab (page-share.feature): the line's summary, and the read itself as the agent
// got it. The server keeps the read as page-read.json on the line; this module only shapes words, so it has no React and no fetch.

/** The fields of a system line this module reads; the line's other fields are left alone. */
interface Line {
  t: string;
  title?: unknown;
  words?: unknown;
}

/** readSummary is "Read: <title>, N words" for a page.read line that names its page; null for any other line, or an old one. */
export function readSummary(line: Line | undefined): string | null {
  if (line?.t !== "page.read" || (line.title === undefined && line.words === undefined)) return null;
  const words = typeof line.words === "number" ? line.words : 0;
  const title = typeof line.title === "string" && line.title ? line.title : "a page with no title";
  return `Read: ${title}, ${words} ${words === 1 ? "word" : "words"}`;
}

interface Read {
  note: string;
  url: string;
  title: string;
  text: string;
  elements: { ref: string; role: string; name: string; value: string }[];
}

const isRead = (v: unknown): v is Read => {
  const r = v as Read | null;
  return typeof r?.note === "string" && typeof r.url === "string" && typeof r.title === "string" && typeof r.text === "string" && Array.isArray(r.elements);
};

/** oneLine keeps a page's word on its line: control characters become spaces (the CLI's oneLine). */
const oneLine = (s: string) => s.replace(/\p{Cc}/gu, " ");

/** readAsText is a kept read as `convoz page read` prints it to the agent: the note first, so the page's words never pass for Convoz's. */
export function readAsText(kept: unknown): string {
  if (!isRead(kept)) return "This file is not a read of a page.";
  const elements = kept.elements.map((e) => `  ${e.ref} ${oneLine(e.role)} ${JSON.stringify(oneLine(e.name))}${e.value ? `: ${oneLine(e.value)}` : ""}`);
  return [kept.note, `URL: ${oneLine(kept.url)}`, `Title: ${oneLine(kept.title)}`, "Elements:", ...elements, "Text:", kept.text.replace(/\n+$/, "")].join("\n");
}
