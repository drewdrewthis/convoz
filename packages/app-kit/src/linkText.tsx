import type { ReactNode } from "react";

/* Links in an ask's plain text. app-kit cannot use the web app's Markdown, and Markdown shows a link's full address anyway:
 * here a link reads as "run 39923502587", "PR 1382" or its host, so a long address never wraps mid-word. */

// The address ends before a space or a quote; punctuation that closes the sentence around it is not part of it.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TAIL = /[.,;:!?)\]}]+$/;
const NUMBERED: [RegExp, string][] = [
  [/\/actions\/runs\/(\d+)/, "run"],
  [/\/pulls?\/(\d+)/, "PR"],
  [/\/issues\/(\d+)/, "issue"],
];

/** shortLink is the visible text of a link: "run 39923502587", "PR 1382", "issue 7", or else its host. */
export function shortLink(url: string): string {
  for (const [re, name] of NUMBERED) {
    const m = re.exec(url);
    if (m) return `${name} ${m[1]}`;
  }
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** linkText draws plain text with each web address as a short link to the full address; the rest of the text is kept as written. */
export function linkText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TAIL, "");
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
