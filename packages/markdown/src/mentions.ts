// @mentions in a run of plain text (I-18). The server finds the same ones with the same rules: this file and
// apps/convoz/internal/server/message/mention.go are twins, and the differential test in e2e/tests/messages-types.wp4.spec.ts
// posts fuzzed bodies through both. A change in one is a change in the other.

const isWord = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
const isHandleChar = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-";

/** One mention found in a run of text: the handle and where "@handle" starts and ends. */
export interface Found {
  handle: string;
  start: number;
  end: number;
}

/**
 * scanMentions finds the "@handle"s in one run of text. The start of the run counts as a boundary. A handle is 2 to 40 of a-z 0-9 -
 * starting with a letter; it is a mention when what comes before the "@" and after the handle is not a word character (an ASCII
 * letter, digit or underscore).
 */
export function scanMentions(text: string): Found[] {
  const out: Found[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && isWord(text[i - 1]!))) continue;
    let j = i + 1;
    if (j >= text.length || text[j]! < "a" || text[j]! > "z") continue;
    while (j < text.length && j - i - 1 < 40 && isHandleChar(text[j]!)) j++;
    if (j - i - 1 < 2 || (j < text.length && isWord(text[j]!))) continue;
    out.push({ handle: text.slice(i + 1, j), start: i, end: j });
    i = j - 1;
  }
  return out;
}
