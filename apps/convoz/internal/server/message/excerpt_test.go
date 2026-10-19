package message_test

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
)

// Owner (conv 19 msg 561): the first / last is probably enough. A cut must never split a multibyte character.
func TestExcerptCutsAt120RunesOnARuneBoundary(t *testing.T) {
	cases := map[string]string{
		"ascii":       strings.Repeat("a", 300),
		"two bytes":   strings.Repeat("é", 300),
		"three bytes": strings.Repeat("日", 300),
		"four bytes":  strings.Repeat("😀", 300),
	}
	for name, in := range cases {
		got := message.Excerpt(in)
		if !utf8.ValidString(got) || utf8.RuneCountInString(got) != 120 || !strings.HasSuffix(got, "…") {
			t.Errorf("%s: %d runes, valid %v, tail %q; want 120 runes ending in an ellipsis", name, utf8.RuneCountInString(got), utf8.ValidString(got), got[len(got)-4:])
		}
	}
}

func TestExcerptKeepsAShortTextWhole(t *testing.T) {
	in := strings.Repeat("日", 120)
	if got := message.Excerpt(in); got != in {
		t.Errorf("a text of exactly 120 runes was changed: %q", got)
	}
	if got := message.Excerpt("**yes**\n\nplease"); got != "yes please" {
		t.Errorf("got %q, want the plain one-line form", got)
	}
}
