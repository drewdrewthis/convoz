package httpapi

import "testing"

func TestMentionsFindsTheHandleAsAWholeWord(t *testing.T) {
	for _, c := range []struct {
		body, handle string
		want         bool
	}{
		{"@devtool can you check?", "devtool", true},
		{"hi @DevTool", "devtool", true},
		{"ping (@devtool)", "devtool", true},
		{"mail devtool@example.com", "devtool", false},
		{"@devtool-two look", "devtool", false},
		{"@dev-search look", "dev-search", true},
		{"no one here", "devtool", false},
		{"@devtool", "", false},
	} {
		if got := mentions(c.body, c.handle); got != c.want {
			t.Errorf("mentions(%q, %q) = %v, want %v", c.body, c.handle, got, c.want)
		}
	}
}
