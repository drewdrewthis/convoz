// Safe markdown. Agent markdown is parsed into a plain tree of nodes we build ourselves (React renders the tree), so no message
// can bring markup, an image, or a script URL. Pure: no DOM, no React, so e2e/lib/chat-markdown.ts runs the same code in Node.

/** One element of the rendered tree: div, p, ul, li, pre, code, strong or a. */
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
const INLINE = /`([^`\n]{1,500})`|\[([^[\]\n]{1,200})\]\(([^()[\]\s]{1,2048})\)|\*\*([^*\n]{1,500}?)\*\*|(https?:\/\/[^\s<>]{1,2048})/g;

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
export function createRenderer(lookalikes: string | null): (source: string) => MdNode {
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
   *  A label made only of plainWords is shown as it is. Any other label could build a host name, so the real host is
   *  appended, unless the label equals the real host (scheme, "www." and case ignored) or is plainWords followed by a
   *  space and the real host. */
  function honestLabel(label: string, target: URL): string {
    const shown = label.trim();
    const host = target.protocol === "mailto:" ? target.pathname : target.host;
    if (!NOT_BLANK.test(shown)) return host;
    if (plainWords(shown)) return shown;
    const real = bare(host);
    const name = shown.toLowerCase().replace(/^https?:\/\//, "");
    if (bare(name) === real) return shown;
    if (name.endsWith(` ${real}`) && plainWords(name.slice(0, -real.length - 1))) return shown;
    return `${shown} (${host})`;
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

  function inline(parent: MdNode, text: string, budget: Budget): void {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) {
        parent.append(el("code", null, m[1]));
      } else if (m[2] != null) {
        const target = parseUrl(m[3]!, budget);
        parent.append(target ? link(m[3]!, honestLabel(m[2], target)) : m[0]);
      } else if (m[4] != null) {
        parent.append(el("strong", null, m[4]));
      } else {
        const url = trimTrailingPunctuation(m[5]!);
        const target = parseUrl(url, budget);
        parent.append(target ? link(url, bareLabel(url, target)) : url, m[5]!.slice(url.length));
      }
    }
    parent.append(text.slice(last));
  }

  return function renderMarkdown(source: string): MdNode {
    const root = el("div", { class: "text" });
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const budget = { links: MAX_LINKS };
    let para: string[] = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      inline(p, para.join("\n"), budget);
      root.append(p);
      para = [];
    };
    let list: MdNode | null = null; // the open bullet list
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}```/.test(lines[i]!)) {
        flush();
        const code: string[] = [];
        for (i++; i < lines.length && !/^\s{0,3}```/.test(lines[i]!); i++) code.push(lines[i]!);
        root.append(el("pre", null, el("code", null, code.join("\n"))));
      } else if (/^\s{0,3}[-*] +\S/.test(lines[i]!) && !para.length) {
        if (!list) {
          list = el("ul");
          root.append(list);
        }
        const li = el("li");
        inline(li, lines[i]!.replace(/^\s{0,3}[-*] +/, ""), budget);
        list.append(li);
        continue;
      } else if (lines[i]!.trim() === "") {
        flush();
      } else {
        para.push(lines[i]!);
      }
      list = null;
    }
    flush();
    return root;
  };
}
