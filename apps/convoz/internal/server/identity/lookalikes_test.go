package identity

import (
	"strings"
	"testing"
)

func TestPunctuationLookalikesHoldTheKnownDisguises(t *testing.T) {
	set := PunctuationLookalikes()
	for _, r := range "\ua78f\u4e36\u119e\ua4f8\u1427\uff0e\u3002\u02d0\u0589\u0887" { // ꞏ 丶 ᆞ ꓸ ᐧ ． 。 ː ։
		if !strings.ContainsRune(set, r) {
			t.Errorf("%U should be a punctuation lookalike", r)
		}
	}
	for _, r := range "a.:/@" { // ASCII is the real thing, and letters are not punctuation
		if strings.ContainsRune(set, r) {
			t.Errorf("%q is not a lookalike", r)
		}
	}
}
