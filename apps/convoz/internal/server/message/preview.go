package message

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PreviewRunes is how much of a message the conversation list shows.
const PreviewRunes = 140

var (
	previewFence   = regexp.MustCompile("(?s)```.*?(```|$)")
	previewBlock   = regexp.MustCompile(`(?m)^[ \t]*(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)`)
	previewLink    = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	previewCode    = regexp.MustCompile("`([^`]*)`")
	previewStrong  = regexp.MustCompile(`(\*\*|__)(.+?)(\*\*|__)`)
	previewEmphasi = regexp.MustCompile(`(^|[\s(])[*_]([^*_\s][^*_]*?)[*_]($|[\s).,!?:;])`)
)

// Preview is the plain text of a markdown body on one line, cut to PreviewRunes runes: the projection the list
// shows (E-21). Format characters (bidi controls, zero-width) are dropped so a body cannot disguise a row.
func Preview(body string) string {
	s := previewFence.ReplaceAllString(body, "code")
	s = previewBlock.ReplaceAllString(s, "")
	s = previewLink.ReplaceAllString(s, "$1")
	s = previewCode.ReplaceAllString(s, "$1")
	s = previewStrong.ReplaceAllString(s, "$2")
	s = previewEmphasi.ReplaceAllString(s, "$1$2$3")
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	line := strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(line) > PreviewRunes {
		return string([]rune(line)[:PreviewRunes])
	}
	return line
}
