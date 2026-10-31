// Package ownerline judges the lines the owner reads and must act on: a plan wait, an ask question, an item-block title.
// Each must be one plain sentence that tells the owner what to do.
package ownerline

import (
	"regexp"
	"strings"
)

var (
	links      = regexp.MustCompile(`(?i)https?://\S+|www\.\S+|#\d+|\bPR\s*#?\d+`)
	versions   = regexp.MustCompile(`\bv?\d+(\.\d+)+\b`)
	words      = regexp.MustCompile(`\p{L}+`)
	markdown   = regexp.MustCompile("`|\\*\\*|\\]\\(|^#|^[-*]\\s")
	status     = regexp.MustCompile(`(?i)^(waiting|pending|blocked|status|fyi|update)\b`)
	abbrev     = regexp.MustCompile(`(?i)\b(e\.g|i\.e|vs|etc)\.`)
	sentenceAt = regexp.MustCompile(`[.?!]\s+\p{Lu}`)
)

// MinWords is the fewest words of letters a line has once links, #N and PR N are removed.
const MinWords = 3

// Check returns why text is not one plain sentence that tells the owner what to do; "" means it is. The reason completes
// "This one ...".
func Check(text string) (why string) {
	t := strings.TrimSpace(text)
	switch {
	case strings.ContainsAny(t, "\r\n"):
		return "has a line break"
	case markdown.MatchString(t):
		return "uses markdown"
	case status.MatchString(t):
		return "starts with a status word"
	case sentenceAt.MatchString(abbrev.ReplaceAllString(t, "$1")):
		return "is more than one sentence"
	case len(words.FindAllString(versions.ReplaceAllString(links.ReplaceAllString(t, " "), " "), -1)) < MinWords:
		return "has fewer than 3 words"
	}
	return ""
}

// Refusal is the message for a refused line: field names where it came from ("waiting", "question", "title"), why is Check's answer.
func Refusal(field, text, why string) string {
	return field + ` must be one plain sentence that tells the owner what to do, like "Approve the prod deploy of PR 240." This one ` + why + `: "` + text + `"`
}
