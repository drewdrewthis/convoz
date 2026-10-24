import type { ReactNode } from "react";

/* Links in an ask's plain text. app-kit cannot use the web app's Markdown, and Markdown shows a link's full address anyway:
 * here a link reads as "run 39923502587", "PR 1382" or its host, so a long address never wraps mid-word. */

// The address ends before a space or a quote; punctuation that closes the sentence around it is not part of it.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TAIL = /[.,;:!?\]}]+$/;
const NUMBERED: [RegExp, string][] = [
  [/^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/, "run"],
  [/^\/[^/]+\/[^/]+\/pulls?\/(\d+)/, "PR"],
  [/^\/[^/]+\/[^/]+\/issues\/(\d+)/, "issue"],
];

/** shortLink is the visible text of a link: "run 39923502587", "PR 1382", "issue 7" for github.com, or else its host. */
export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    if (host === "github.com") {
      for (const [re, name] of NUMBERED) {
        const m = re.exec(u.pathname);
        if (m) return `${name} ${m[1]}`;
      }
    }
    return host;
  } catch {
    return url;
  }
}

/** trimTail drops the punctuation that closes the sentence around an address; a ")" stays when it closes a "(" inside the address. */
function trimTail(raw: string): string {
  let url = raw.replace(TAIL, "");
  while (url.endsWith(")") && count(url, ")") > count(url, "(")) url = url.slice(0, -1).replace(TAIL, "");
  return url;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** linkText draws plain text with each web address as a short link to the full address; the rest of the text is kept as written. */
export function linkText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimTail(m[0]);
    out.push(text.slice(at, m.index));
    out.push(
      <a key={m.index} href={url} target="_blank" rel="noopener noreferrer" title={url} className="whitespace-nowrap text-accent-text">
        {shortLink(url)}
      </a>,
    );
    at = m.index + url.length;
  }
  out.push(text.slice(at));
  return out;
}
