// Safe markdown. Agent markdown is parsed into a plain tree of nodes we build ourselves (React renders the tree), so no message
// can bring markup, an image, or a script URL. Pure: no DOM, no React, so e2e/lib/chat-markdown.ts runs the same code in Node.

import { scanMentions } from "./mentions.ts";
import { tokenizeV2, type V2Style } from "./v2.ts";

export { scanMentions } from "./mentions.ts";
export { tokenizeV2 } from "./v2.ts";
export { project, type Projectable, type ProjectForm } from "./project.ts";

/** One element of the rendered tree: div, p, ul, li, pre, code, strong, em, u, s, blockquote, span or a. */
export interface MdNode {
  tag: string;
  attrs: Record<string, string> | null;
  kids: MdChild[];
  append(...more: MdChild[]): void;
}
export type MdChild = MdNode | string;

function el(tag: string, attrs: Record<string, string> | null = null, ...kids: MdChild[]): MdNode {
  return { tag, attrs, kids, append: (...more: MdChild[]) => void kids.push(...more) };
}

// Every quantifier is bounded. The label class excludes "[" and the URL class excludes "(", "[" and whitespace, so a scan
// started at one "[" ends at the next one: O(1) work per start, linear overall.
const INLINE = /`([^`\n]{1,500})`|\[([^[\]\n]{1,200})\]\(([^()[\]\s]{1,1000})\)|\*\*([^*\n]{1,500}?)\*\*|(https?:\/\/[^\s<>]{1,1000})|!\[([^[\]\n]{0,200})\]\(([^()[\]\s]{1,1000})\)/g;

// Links past this many in one message stay plain text: it bounds the work a link flood can cost.
const MAX_LINKS = 200;

interface Budget {
  links: number;
}

/** parseUrl returns the URL object of u when it is an absolute http, https or mailto URL, else null. It charges one link
 *  from the budget per attempt, so a flood of URLs that fail to parse costs no more than a flood of good ones. */
function parseUrl(u: string, budget: Budget): URL | null {
  if (budget.links <= 0) return null;
  budget.links--;
  try {
    const url = new URL(u);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const link = (href: string, label: string) => el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
// Scripts a label may be written in. Han, kana and Hangul count as one group (Japanese and Korean mix them); every
// other script stands alone, and a letter from a script not listed here is never trusted.
const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script_Extensions=Latin}/u], ["cyrillic", /\p{Script_Extensions=Cyrillic}/u], ["greek", /\p{Script_Extensions=Greek}/u],
  ["cjk", /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u],
  ["arabic", /\p{Script_Extensions=Arabic}/u], ["hebrew", /\p{Script_Extensions=Hebrew}/u], ["devanagari", /\p{Script_Extensions=Devanagari}/u],
  ["thai", /\p{Script_Extensions=Thai}/u], ["armenian", /\p{Script_Extensions=Armenian}/u], ["georgian", /\p{Script_Extensions=Georgian}/u],
];
// Hangul fillers and the braille blank look empty; they are Lo or So, so they are named here and never trusted.
const FILLER_CHARS = "ᅟᅠㅤﾠ⠀";
const FILLERS = new RegExp("[" + FILLER_CHARS + "]");
// Scripts whose "Lo" letters include lookalikes of dots and bars (ǀ ǃ ʔ ª º): only their cased letters are trusted.
// This is a rule about the script's letter classes, not a list of characters, so it does not copy the server's table;
// NFKC cannot replace it because it keeps ǃ and ʔ as they are and turns ª into a plain "a".
const CASED_ONLY = ["latin", "cyrillic", "greek", "armenian", "georgian"];
const NOT_BLANK = new RegExp("[^\\p{Cf}\\p{M}\\p{Z}\\p{Cc}" + FILLER_CHARS + "]", "u");
// overlay, enclosing and symbol-combining marks: they draw a slash, ring or bar over the letter before them (this
// also covers the above-marks U+20D0-20F0), so they are never part of a word.
const OVERLAY_MARKS = /[\p{Me}̴-̸⃐-⃰\u{101FD}\u{1ABE}\u{1CF37}\u{1CF3E}]/u;

/**
 * createRenderer returns renderMarkdown, which builds paragraphs, bullet lists, fenced code, inline code, bold and links;
 * anything else stays literal text.
 *
 * `lookalikes` is the server's set of lookalike punctuation (ꞏ 丶 ᆞ ...), served as /assets/lookalikes.js; the server owns the
 * table. null when that asset did not load: plainWords then fails closed for anything that is not plain ASCII.
 */
export function createRenderer(lookalikes: string | null): (source: string, opts?: RenderOptions) => MdNode {
  const LOOKALIKES = typeof lookalikes === "string" ? new Set(Array.from(lookalikes)) : null;

  /** plainWords is true when text is plain ASCII letters and spaces, or words of ONE script that passes every rule below
   *  (so it cannot pass for a host name). It is false for every non-ASCII text when the server's lookalike list did not load.
   *  After NFC each character must be
   *  - a space (Zs), or
   *  - a combining mark right after a letter of the same script (or an Inherited mark), never an overlay, enclosing or
   *    symbol-combining mark (any Me, U+0334-0338, U+20D0-20F0, U+101FD, U+1ABE, U+1CF37, U+1CF3E), or
   *  - a letter (Lu, Ll, Lt or Lo; never Lm, Sk, digits, symbols, format characters or the fillers) of a script in SCRIPTS,
   *    where Han, kana and Hangul count as one script, and a tie to a second script fails the label;
   *    Latin, Cyrillic, Greek, Armenian and Georgian trust only cased letters (CASED_ONLY);
   *    and the letter, read in NFKC form, is made only of letters and is none of the server's lookalikes
   *    (so Latin "ŀ" = "l" + middle dot and Hangul "ㆍ" = "ᆞ" fail).
   *  A character in the server's lookalike list always fails. */
  function plainWords(text: string): boolean {
    if (/^[A-Za-z ]*$/.test(text)) return true;
    if (!LOOKALIKES) return false;
    let script: string | null = null;
    let letterScript: RegExp | null = null;
    let afterLetter = false;
    for (const ch of text.normalize("NFC")) {
      if (LOOKALIKES.has(ch)) return false;
      if (/\p{Zs}/u.test(ch)) {
        afterLetter = false;
      } else if (/\p{M}/u.test(ch)) {
        // a mark belongs to the script of its letter (Devanagari visarga after a Latin letter is a colon in disguise)
        if (!afterLetter || OVERLAY_MARKS.test(ch) || !(letterScript!.test(ch) || /\p{Script_Extensions=Inherited}/u.test(ch))) return false;
      } else if (/[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]/u.test(ch) && !FILLERS.test(ch)) {
        const own = SCRIPTS.find(([, re]) => re.test(ch));
        if (!own || (script && script !== own[0])) return false;
        if (CASED_ONLY.includes(own[0]) && /\p{Lo}/u.test(ch)) return false;
        for (const part of ch.normalize("NFKC")) {
          if (LOOKALIKES.has(part) || !/[\p{L}\p{M}]/u.test(part)) return false;
        }
        script = own[0];
        letterScript = own[1];
        afterLetter = true;
      } else {
        return false;
      }
    }
    return true;
  }

  /** honestLabel stops a link from naming one site and opening another. A blank or invisible label shows the real host.
   *  A label made only of plainWords is shown as it is, and the real host is shown beside the link (`beside`), so a link never
   *  hides where it goes. Any other label could build a host name, so the real host is appended to it, unless the label equals
   *  the real host (scheme, "www." and case ignored) or is plainWords followed by a space and the real host. */
  function honestLabel(label: string, target: URL): { text: string; beside: string | null } {
    const shown = label.trim();
    const host = target.protocol === "mailto:" ? target.pathname : target.host;
    if (!NOT_BLANK.test(shown)) return { text: host, beside: null };
    if (plainWords(shown)) return { text: shown, beside: target.protocol === "mailto:" ? null : host };
    const real = bare(host);
    const name = shown.toLowerCase().replace(/^https?:\/\//, "");
    if (bare(name) === real) return { text: shown, beside: null };
    if (name.endsWith(` ${real}`) && plainWords(name.slice(0, -real.length - 1))) return { text: shown, beside: null };
    return { text: `${shown} (${host})`, beside: null };
  }

  /** trimTrailingPunctuation drops sentence punctuation from the end of a URL with one linear scan (a regex here was
   *  quadratic). A final ")" stays when the URL has a "(" for it. */
  function trimTrailingPunctuation(url: string): string {
    let open = 0;
    let close = 0;
    for (const ch of url) {
      if (ch === "(") open++;
      else if (ch === ")") close++;
    }
    let end = url.length;
    while (end > 0 && ".,;:!?)]".includes(url[end - 1]!)) {
      if (url[end - 1] === ")") {
        if (open >= close) break;
        close--;
      }
      end--;
    }
    return url.slice(0, end);
  }

  /** bareLabel shows a bare URL as written, except that a non-ASCII host shows as its punycode form (the rest of the URL
   *  stays as typed) and a URL with "@" or "\" in its authority shows only the host it really opens. */
  function bareLabel(text: string, target: URL): string {
    const authority = text.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0]!;
    // "@" and "\" can make the typed host differ from the real one (paypal.com@evil.test)
    if (/[@\\]/.test(authority)) return target.host;
    if (!/[^\x00-\x7f]/.test(authority)) return text;
    const scheme = text.match(/^https?:\/\//i)![0];
    return scheme + target.host + text.slice(scheme.length + authority.length);
  }

  /** appendLink adds a link whose label the author chose, honestly: the host it opens sits beside a label of plain words. */
  function appendLink(parent: MdNode, href: string, label: string, target: URL): void {
    const { text, beside } = honestLabel(label, target);
    parent.append(link(href, text));
    if (beside) parent.append(el("span", { class: "host" }, beside)); // the page draws the parentheses, so the tree holds the bare host
  }

  /** words adds a run of plain text; a known @handle in it becomes a mention span. `on` is false inside quotes, where nothing is mentioned. */
  function words(parent: MdNode, text: string, ctx: Ctx, on: boolean): void {
    if (!on || !ctx.handles) {
      parent.append(text);
      return;
    }
    let last = 0;
    for (const f of scanMentions(text)) {
      if (!ctx.handles.has(f.handle)) continue;
      parent.append(text.slice(last, f.start), el("span", { class: "mention" }, `@${f.handle}`));
      last = f.end;
    }
    parent.append(text.slice(last));
  }

  function inline(parent: MdNode, text: string, ctx: Ctx, on: boolean): void {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      words(parent, text.slice(last, m.index), ctx, on);
      last = m.index + m[0].length;
      if (m[1] != null) {
        parent.append(el("code", null, m[1]));
      } else if (m[2] != null) {
        const target = parseUrl(m[3]!, ctx.budget);
        if (target) appendLink(parent, m[3]!, m[2], target);
        else parent.append(m[0]);
      } else if (m[4] != null) {
        const bold = el("strong");
        words(bold, m[4], ctx, on);
        parent.append(bold);
      } else if (m[5] != null) {
        const url = trimTrailingPunctuation(m[5]);
        const target = parseUrl(url, ctx.budget);
        parent.append(target ? link(url, bareLabel(url, target)) : url, m[5].slice(url.length));
      } else {
        // an image is never loaded: the owner gets a link to where it is (I-45). Images of own uploads arrive with the upload module.
        const target = parseUrl(m[7]!, ctx.budget);
        if (!target) parent.append(m[0]);
        else if (m[6]!.trim()) appendLink(parent, m[7]!, m[6]!, target);
        else parent.append(link(m[7]!, bareLabel(m[7]!, target)));
      }
    }
    words(parent, text.slice(last), ctx, on);
  }

  const V2_TAG: Record<V2Style, [string, Record<string, string> | null]> = {
    spoiler: ["span", { class: "spoiler" }],
    underline: ["u", null],
    bold: ["strong", null],
    italic: ["em", null],
    strike: ["s", null],
  };

  function inlineV2(parent: MdNode, text: string, ctx: Ctx, on: boolean): void {
    for (const t of tokenizeV2(text)) {
      switch (t.kind) {
        case "text":
          words(parent, t.text, ctx, on);
          break;
        case "code":
          parent.append(el("code", null, t.text));
          break;
        case "link": {
          const target = parseUrl(t.url, ctx.budget);
          if (target) appendLink(parent, t.url, t.label, target);
          else parent.append(`[${t.label}](${t.url})`);
          break;
        }
        case "style": {
          const [tag, attrs] = V2_TAG[t.style];
          const node = el(tag, attrs);
          words(node, t.text, ctx, on);
          parent.append(node);
          break;
        }
      }
    }
  }

  const FENCE = /^\s{0,3}```/;
  const ONE_PRE = /^\s{0,3}```.*```\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const BULLET = /^\s{0,3}[-*] +\S/;

  /** blocks draws the lines of a markdown or MarkdownV2 body: fenced code, quotes, bullets (markdown only) and paragraphs. */
  function blocks(root: MdNode, lines: string[], v2: boolean, ctx: Ctx): void {
    const inlineOf = v2 ? inlineV2 : inline;
    let para: string[] = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      inlineOf(p, para.join("\n"), ctx, true);
      root.append(p);
      para = [];
    };
    let quote: string[] = [];
    const flushQuote = () => {
      if (!quote.length) return;
      const q = el("blockquote");
      const p = el("p");
      inlineOf(p, quote.join("\n"), ctx, false); // a quote mentions no one: it repeats what someone said
      q.append(p);
      root.append(q);
      quote = [];
    };
    let list: MdNode | null = null; // the open bullet list
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (FENCE.test(line)) {
        flush();
        flushQuote();
        if (v2 && ONE_PRE.test(line)) {
          root.append(el("pre", null, el("code", null, line.trim().slice(3, -3))));
        } else {
          const code: string[] = [];
          for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) code.push(lines[i]!);
          root.append(el("pre", null, el("code", null, code.join("\n"))));
        }
      } else if (QUOTE.test(line)) {
        flush();
        quote.push(line.replace(/^\s{0,3}>[ \t]?/, ""));
        list = null;
        continue;
      } else if (!v2 && BULLET.test(line) && !para.length) {
        flushQuote();
        if (!list) {
          list = el("ul");
          root.append(list);
        }
        const li = el("li");
        inline(li, line.replace(/^\s{0,3}[-*] +/, ""), ctx, true);
        list.append(li);
        continue;
      } else if (line.trim() === "") {
        flush();
        flushQuote();
      } else {
        flushQuote();
        para.push(line);
      }
      list = null;
    }
    flush();
    flushQuote();
  }

  return function renderMarkdown(source: string, opts: RenderOptions = {}): MdNode {
    const root = el("div", { class: "text" });
    const ctx: Ctx = { budget: { links: MAX_LINKS }, handles: opts.handles ?? null };
    const text = source.replace(/\r\n?/g, "\n");
    if (opts.format === "plain") words(root, text, ctx, true);
    else blocks(root, text.split("\n"), opts.format === "markdownv2", ctx);
    return root;
  };
}

/** How a body is drawn: its format (markdown when not given) and, when known, the handles that count as mentions. */
export interface RenderOptions {
  format?: "markdown" | "markdownv2" | "plain";
  /** The handles of the people and agents the app knows. A mention of one is drawn as a span of class "mention". */
  handles?: { has(handle: string): boolean };
}

interface Ctx {
  budget: Budget;
  handles: { has(handle: string): boolean } | null;
}

const everyone = { has: () => true };

/** mentionsOf lists the handles a body mentions, each once, in order: what the page would highlight if it knew every handle. */
export function mentionsOf(source: string, format: RenderOptions["format"] = "markdown"): string[] {
  const seen: string[] = [];
  const walk = (node: MdChild) => {
    if (typeof node === "string") return;
    if (node.tag === "span" && node.attrs?.class === "mention") {
      const handle = (node.kids[0] as string).slice(1);
      if (!seen.includes(handle)) seen.push(handle);
    }
    node.kids.forEach(walk);
  };
  walk(createRenderer(null)(source, { format, handles: everyone }));
  return seen;
}
