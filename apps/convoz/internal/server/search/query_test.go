package search_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/search"
)

func TestParse(t *testing.T) {
	q := search.Parse(`from:@devtool has:file in:"Deploy alerts" is:ask chart @docs "exact phrase" is:starred is:pinned is:app has:link in: from:`)
	if !reflect.DeepEqual(q.From, []string{"devtool", "docs"}) || !reflect.DeepEqual(q.In, []string{"Deploy alerts"}) {
		t.Errorf("from %v in %v", q.From, q.In)
	}
	if !q.File || !q.Ask || !q.Starred || !q.Pinned || !q.App || !q.Link {
		t.Errorf("flags: %+v", q)
	}
	if !reflect.DeepEqual(q.Terms, []string{"chart", "exact phrase"}) {
		t.Errorf("terms %v", q.Terms)
	}
	var labels []string
	for _, c := range q.Chips {
		labels = append(labels, c.Label)
	}
	if got := strings.Join(labels, "|"); got != "from @devtool|has file|in conversation Deploy alerts|is ask|from @docs|is starred|is pinned|is app|has link" {
		t.Errorf("chips: %s", got)
	}
	if search.Parse("   ").Empty() != true || search.Parse("in:").Empty() != true || search.Parse("is:ask").Empty() {
		t.Error("Empty")
	}
}

func TestParse_SyntaxTypedByTheUserIsOnlyWords(t *testing.T) {
	// NEAR, AND, quotes, stars and a colon must not reach FTS5 as operators: the statement must not fail.
	s := seed(t)
	post(t, s, 1, "a b c")
	for _, text := range []string{`NEAR(a b)`, `a AND`, `"unterminated`, `a*`, `col:umn`, `)(`, `-a`, `'`} {
		if _, err := search.Run(t.Context(), s.Reader.SQL(), search.Parse(text), all(), 20); err != nil {
			t.Errorf("%q: %v", text, err)
		}
	}
}

func TestSnippet(t *testing.T) {
	parts := search.Snippet("retry budget is 3 attempts", search.Parse("budget"))
	want := []search.Part{{Text: "retry "}, {Text: "budget", Hit: true}, {Text: " is 3 attempts"}}
	if !reflect.DeepEqual(parts, want) {
		t.Errorf("got %+v", parts)
	}
	long := strings.Repeat("word ", 60) + "needle " + strings.Repeat("tail ", 60)
	parts = search.Snippet(long, search.Parse("needle"))
	if parts[0].Text != "…" || parts[len(parts)-1].Text != "…" {
		t.Errorf("a long text is cut on both sides: %+v", parts)
	}
	hits := 0
	for _, p := range parts {
		if p.Hit {
			hits++
		}
	}
	if hits != 1 {
		t.Errorf("hits %d", hits)
	}
	if got := search.Snippet("Rollback and ROUTER", search.Parse("ro")); !got[0].Hit || got[0].Text != "Ro" {
		t.Errorf("a prefix match marks the prefix, case folded: %+v", got)
	}
	if got := search.Snippet("<b>x</b> & more", search.Parse("more")); got[0].Text != "<b>x</b> & " {
		t.Errorf("markup stays text: %+v", got)
	}
}
