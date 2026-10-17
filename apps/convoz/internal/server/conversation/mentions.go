package conversation

import (
	"regexp"
	"strings"
)

var (
	mentionFence  = regexp.MustCompile("(?s)```.*?(```|$)")
	mentionInline = regexp.MustCompile("`[^`\n]*`")
	mentionAt     = regexp.MustCompile(`(?:^|[^A-Za-z0-9_@/.+-])@([a-z][a-z0-9-]{1,39})\b`)
)

// MaxMentions bounds how many agents one message can bring in.
const MaxMentions = MaxParticipants

// Mentioned lists the handles a message @mentions, in order and without repeats. A mention inside a code block, inline
// code or a quoted line is not one (I-18).
func Mentioned(body string) []string {
	text := mentionInline.ReplaceAllString(mentionFence.ReplaceAllString(body, ""), "")
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(strings.TrimLeft(line, " \t"), ">") {
			lines = append(lines, line)
		}
	}
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionAt.FindAllStringSubmatch(strings.Join(lines, "\n"), -1) {
		if h := m[1]; !seen[h] && len(out) < MaxMentions {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}
