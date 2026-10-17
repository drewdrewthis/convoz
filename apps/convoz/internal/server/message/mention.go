package message

import (
	"regexp"
	"strings"
)

// Mentions (I-18). The server and the web app must agree on which @handles a body mentions, so this file is a line-for-line
// twin of packages/markdown (mentions.ts, v2.ts and the block and inline passes of index.ts). A change in one is a change in
// the other, and the differential test in e2e/tests/messages-types.wp4.spec.ts posts fuzzed bodies through both.
//
// Checked and rejected: goldmark. The web renderer is a small grammar of its own (fences, bullets, quotes, code, links, bold),
// and a CommonMark parser would find other code spans, links and quotes than the page draws, so a handle could be stored as a
// mention that the page shows as plain text, or the reverse.

// jsSpace is what JavaScript's \s and trim() treat as white space; RE2's \s is ASCII only, so the twin spells it out.
const jsSpace = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	fenceLine = regexp.MustCompile("^[" + jsSpace + "]{0,3}```")
	quoteLine = regexp.MustCompile("^[" + jsSpace + "]{0,3}>")
	bullet    = regexp.MustCompile("^[" + jsSpace + "]{0,3}[-*] +[^" + jsSpace + "]")
	bulletTip = regexp.MustCompile("^[" + jsSpace + "]{0,3}[-*] +")
	onePre    = regexp.MustCompile("^[" + jsSpace + "]{0,3}```[^\\n\\r\\x{2028}\\x{2029}]*```[" + jsSpace + "]*$")
	mdInline  = regexp.MustCompile("`([^`\\n]{1,500})`|\\[([^\\[\\]\\n]{1,200})\\]\\(([^()\\[\\][" + jsSpace + "]{1,1000})\\)|\\*\\*([^*\\n]{1,500}?)\\*\\*|(https?://[^" + jsSpace + "<>]{1,1000})|!\\[([^\\[\\]\\n]{0,200})\\]\\(([^()\\[\\][" + jsSpace + "]{1,1000})\\)")
	v2Code    = regexp.MustCompile("^`[^`\\n]{1,500}`")
	v2Link    = regexp.MustCompile("^\\[[^\\[\\]\\n]{1,200}\\]\\([^()\\[\\][" + jsSpace + "]{1,1000}\\)")
	v2Styles  = []*regexp.Regexp{
		regexp.MustCompile(`^\|\|([^|\n]{1,500}?)\|\|`),
		regexp.MustCompile(`^__([^_\n]{1,500}?)__`),
		regexp.MustCompile(`^\*([^*\n]{1,500}?)\*`),
		regexp.MustCompile(`^_([^_\n]{1,500}?)_`),
		regexp.MustCompile(`^~([^~\n]{1,500}?)~`),
	}
)

// ParseMentions lists the handles a body mentions, each once, in the order they first appear. Text in code, in a quote, in a
// link or in a bare URL mentions no one. A handle that names no identity is the caller's to drop.
func ParseMentions(body, format string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(text string) {
		for _, h := range scanMentions(text) {
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	text := strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\r", "\n")
	switch format {
	case "plain":
		add(text)
	case "markdownv2":
		blocks(text, false, func(para string) { v2Segments(para, add) })
	default:
		blocks(text, true, func(para string) { mdSegments(para, add) })
	}
	return out
}

// blocks walks the lines the way the page's block pass does and hands every paragraph and bullet to inline. Fenced code and
// quoted lines are skipped. bullets is false for MarkdownV2, which has no lists.
func blocks(text string, bullets bool, inline func(string)) {
	lines := strings.Split(text, "\n")
	var para []string
	flush := func() {
		if len(para) > 0 {
			inline(strings.Join(para, "\n"))
			para = nil
		}
	}
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		switch {
		case fenceLine.MatchString(line):
			flush()
			if !bullets && onePre.MatchString(line) {
				continue
			}
			for i++; i < len(lines) && !fenceLine.MatchString(lines[i]); i++ {
			}
		case quoteLine.MatchString(line):
			flush()
		case bullets && len(para) == 0 && bullet.MatchString(line):
			inline(bulletTip.ReplaceAllString(line, ""))
		case jsTrim(line) == "":
			flush()
		default:
			para = append(para, line)
		}
	}
	flush()
}

func mdSegments(text string, add func(string)) {
	last := 0
	for _, m := range mdInline.FindAllStringSubmatchIndex(text, -1) {
		add(text[last:m[0]])
		last = m[1]
		if m[8] >= 0 { // bold: its inside is plain text
			add(text[m[8]:m[9]])
		}
	}
	add(text[last:])
}

func v2Segments(text string, add func(string)) {
	var buf strings.Builder
	flush := func() {
		add(buf.String())
		buf.Reset()
	}
	for i := 0; i < len(text); {
		rest := text[i:]
		if rest[0] == '\\' && len(rest) > 1 && isASCIIPunct(rest[1]) {
			buf.WriteByte(rest[1])
			i += 2
			continue
		}
		if n := v2Code.FindString(rest); n != "" {
			flush()
			i += len(n)
			continue
		}
		if n := v2Link.FindString(rest); n != "" {
			flush()
			i += len(n)
			continue
		}
		matched := false
		for _, re := range v2Styles {
			if m := re.FindStringSubmatch(rest); m != nil {
				flush()
				add(unescape(m[1]))
				i += len(m[0])
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		buf.WriteByte(rest[0])
		i++
	}
	flush()
}

func isASCIIPunct(b byte) bool {
	return b >= '!' && b <= '/' || b >= ':' && b <= '@' || b >= '[' && b <= '`' || b >= '{' && b <= '~'
}

func unescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && isASCIIPunct(s[i+1]) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// jsTrim is String.prototype.trim: it removes the characters JavaScript calls white space.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch {
		case r == '\t', r == '\n', r == '\v', r == '\f', r == '\r', r == ' ', r == 0xa0, r == 0x1680, r >= 0x2000 && r <= 0x200a,
			r == 0x2028, r == 0x2029, r == 0x202f, r == 0x205f, r == 0x3000, r == 0xfeff:
			return true
		}
		return false
	})
}

// scanMentions finds the @handles in one run of plain text. The start of the run counts as a boundary. A handle is 2 to 40
// of a-z 0-9 - starting with a letter; it is a mention when what comes before the "@" and after the handle is not a word
// character (ASCII letter, digit or underscore).
func scanMentions(text string) []string {
	var out []string
	for i := 0; i < len(text); i++ {
		if text[i] != '@' || i > 0 && isWord(text[i-1]) {
			continue
		}
		j := i + 1
		if j >= len(text) || text[j] < 'a' || text[j] > 'z' {
			continue
		}
		for j < len(text) && j-i-1 < 40 && (text[j] >= 'a' && text[j] <= 'z' || text[j] >= '0' && text[j] <= '9' || text[j] == '-') {
			j++
		}
		if j-i-1 < 2 || j < len(text) && isWord(text[j]) {
			continue
		}
		out = append(out, text[i+1:j])
		i = j - 1
	}
	return out
}

func isWord(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_'
}
