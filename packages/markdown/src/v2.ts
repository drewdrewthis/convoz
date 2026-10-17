// MarkdownV2 (Telegram) tokens of one line. Pure, so the server's twin (message/mention.go: v2Segments, v2Line) can follow it
// rule for rule: a backslash escapes any ASCII punctuation; code, a link or one style span is matched at the cursor; an opener without a
// closer stays literal. Styles do not nest: the inside of a span is plain text.

export type V2Style = "spoiler" | "underline" | "bold" | "italic" | "strike";

export type V2Token =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "style"; style: V2Style; text: string };

const SPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const CODE = /`([^`\n]{1,500})`/y;
const LINK = new RegExp(`\\[([^[\\]\\n]{1,200})\\]\\(([^()[\\]${SPACE}]{1,1000})\\)`, "y");
const STYLES: [V2Style, RegExp][] = [
  ["spoiler", /\|\|([^|\n]{1,500}?)\|\|/y],
  ["underline", /__([^_\n]{1,500}?)__/y],
  ["bold", /\*([^*\n]{1,500}?)\*/y],
  ["italic", /_([^_\n]{1,500}?)_/y],
  ["strike", /~([^~\n]{1,500}?)~/y],
];
const PUNCT = /[!-/:-@[-`{-~]/;

/** unescape drops the backslash before ASCII punctuation. */
export const unescapeV2 = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/** tokenizeV2 splits one line (or a paragraph's lines joined by newlines) of MarkdownV2 into tokens. */
export function tokenizeV2(text: string): V2Token[] {
  const out: V2Token[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    let m = at(CODE, text, i);
    if (m) {
      flush();
      out.push({ kind: "code", text: m[1]! });
      i += m[0].length;
      continue;
    }
    if ((m = at(LINK, text, i))) {
      flush();
      out.push({ kind: "link", label: m[1]!, url: m[2]! });
      i += m[0].length;
      continue;
    }
    let styled = false;
    for (const [style, re] of STYLES) {
      if ((m = at(re, text, i))) {
        flush();
        out.push({ kind: "style", style, text: unescapeV2(m[1]!) });
        i += m[0].length;
        styled = true;
        break;
      }
    }
    if (styled) continue;
    buf += ch;
    i++;
  }
  flush();
  return out;
}
