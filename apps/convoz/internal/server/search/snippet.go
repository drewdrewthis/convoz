package search

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Part is a run of a snippet. Hit says the run is a word the query matched; the page marks it with weight as well as a tint,
// so a match never relies on colour alone.
type Part struct {
	Text string `json:"text"`
	Hit  bool   `json:"hit,omitempty"`
}

const (
	snippetBefore = 36  // runes kept before the first match
	snippetLength = 110 // runes in the whole snippet
)

// Snippet is a window of text around its first matched word, with the matched words marked. The text is the message's plain
// words (its projection), so no markup can sit in a part. A word matches as the start of a word of the text, as the index
// does for a prefix.
func Snippet(text string, q Query) []Part {
	flat := strings.Join(strings.Fields(text), " ")
	words := q.words()
	if flat == "" {
		return nil
	}
	if len(words) == 0 {
		return window(flat, 0, nil)
	}
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = regexp.QuoteMeta(w)
	}
	// A match starts a word: the text before it is not a letter or a digit.
	re := regexp.MustCompile(`(?i)(^|[^\pL\pN])(` + strings.Join(quoted, "|") + `)`)
	first := re.FindStringSubmatchIndex(flat)
	at := 0
	if first != nil {
		at = utf8.RuneCountInString(flat[:first[4]])
	}
	return window(flat, at, re)
}

// window cuts snippetLength runes starting snippetBefore before at, with an ellipsis where text was cut, and marks the matches.
func window(flat string, at int, re *regexp.Regexp) []Part {
	runes := []rune(flat)
	from := max(0, at-snippetBefore)
	to := min(len(runes), from+snippetLength)
	cut := string(runes[from:to])
	var parts []Part
	if from > 0 {
		parts = append(parts, Part{Text: "…"})
	}
	parts = append(parts, mark(cut, re)...)
	if to < len(runes) {
		parts = append(parts, Part{Text: "…"})
	}
	return parts
}

func mark(text string, re *regexp.Regexp) []Part {
	if re == nil {
		return []Part{{Text: text}}
	}
	var parts []Part
	last := 0
	for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
		start, end := m[4], m[5]
		if start > last {
			parts = append(parts, Part{Text: text[last:start]})
		}
		parts = append(parts, Part{Text: text[start:end], Hit: true})
		last = end
	}
	if last < len(text) {
		parts = append(parts, Part{Text: text[last:]})
	}
	return parts
}
