package search_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/search"
)

// seed has the owner (1), two agents (2, 3) and two conversations (10, 20); message n is written by 2 in 10 when n is odd and by 3 in 20 when even.
func seed(t *testing.T) *pdb.Store {
	t.Helper()
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1),(3,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`,
		`INSERT INTO conversations (id, title, created_by, created_at, last_activity_at) VALUES (10,'Ship search filters',1,1,1),(20,'Deploy alerts runbook',1,1,1)`)
	return s
}

func post(t *testing.T, s *pdb.Store, id int64, text string) {
	t.Helper()
	conv, author := int64(10), int64(2)
	if id%2 == 0 {
		conv, author = 20, 3
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if _, err := d.ExecContext(ctx, `INSERT OR IGNORE INTO messages (id, conversation_id, author_id, kind, format, body, created_at) VALUES (?, ?, ?, 'text', 'plain', ?, ?)`, id, conv, author, text, id); err != nil {
			return err
		}
		return search.Index(ctx, d, search.Entry{MessageID: id, ConversationID: conv, AuthorID: author, Kind: "text", Link: search.HasLink(text), CreatedAt: id, Text: text})
	})
}

func run(t *testing.T, s *pdb.Store, text string, sc search.Scope) []int64 {
	t.Helper()
	hits, err := search.Run(context.Background(), s.Reader.SQL(), search.Parse(text), sc, 20)
	if err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for _, h := range hits {
		ids = append(ids, h.MessageID)
	}
	return ids
}

func all() search.Scope {
	return search.Scope{
		Visible: []search.Visible{{ID: 10, Title: "Ship search filters"}, {ID: 20, Title: "Deploy alerts runbook"}},
		People:  []search.Person{{ID: 1, Handle: "drew"}, {ID: 2, Handle: "devtool"}, {ID: 3, Handle: "docs"}},
	}
}

func TestRun_NewestFirstAndTwoLetterPrefix(t *testing.T) {
	s := seed(t)
	post(t, s, 1, "rollback the deploy")
	post(t, s, 2, "the router is slow")
	post(t, s, 3, "rollback again")
	if got, want := run(t, s, "rollback", all()), []int64{3, 1}; !reflect.DeepEqual(got, want) {
		t.Errorf("rollback: got %v, want newest first %v", got, want)
	}
	if got, want := run(t, s, "ro", all()), []int64{3, 2, 1}; !reflect.DeepEqual(got, want) {
		t.Errorf("a two-letter prefix finds rollback and router: got %v, want %v", got, want)
	}
}

func TestRun_FiltersNarrow(t *testing.T) {
	s := seed(t)
	post(t, s, 1, "deploy error see https://x.dev/a")
	post(t, s, 2, "deploy error in the runbook")
	for _, c := range []struct {
		q    string
		want []int64
	}{
		{"from:@devtool deploy", []int64{1}},
		{"@docs deploy", []int64{2}},
		{`in:"Deploy alerts" error`, []int64{2}},
		{"in:10", []int64{1}},
		{"has:link", []int64{1}},
		{"is:ask", []int64{}},
		{"is:app", []int64{}},
		{"from:@nobody deploy", []int64{}},
		{`"deploy error"`, []int64{2, 1}},
	} {
		if got := run(t, s, c.q, all()); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %v, want %v", c.q, got, c.want)
		}
	}
}

func TestRun_PinnedStarredAndFilesComeFromTheirOwners(t *testing.T) {
	s := seed(t)
	post(t, s, 1, "one")
	post(t, s, 2, "two")
	sc := all()
	sc.Pinned = func() ([]int64, error) { return []int64{2}, nil }
	sc.Starred = func() ([]int64, error) { return []int64{10}, nil }
	sc.Files = func() ([]int64, error) { return nil, nil }
	for q, want := range map[string][]int64{"is:pinned": {2}, "is:starred": {1}, "has:file": {}} {
		if got := run(t, s, q, sc); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v, want %v", q, got, want)
		}
	}
}

func TestRun_ShowsOnlyWhatTheScopeAllows(t *testing.T) {
	s := seed(t)
	post(t, s, 1, "merger plan")
	post(t, s, 2, "merger plan")
	post(t, s, 3, "merger plan")
	only20 := search.Scope{Visible: []search.Visible{{ID: 20, Title: "Deploy alerts runbook"}}}
	if got, want := run(t, s, "merger", only20), []int64{2}; !reflect.DeepEqual(got, want) {
		t.Errorf("a viewer of conversation 20 only: got %v, want %v", got, want)
	}
	// A message at or below the floor is not the viewer's: it joined after it.
	floor := search.Scope{Visible: []search.Visible{{ID: 10, Title: "x", Floor: 1}}}
	if got, want := run(t, s, "merger", floor), []int64{3}; !reflect.DeepEqual(got, want) {
		t.Errorf("a floor of 1: got %v, want %v", got, want)
	}
	if got := run(t, s, "merger", search.Scope{}); len(got) != 0 {
		t.Errorf("no visible conversation finds nothing, got %v", got)
	}
}

func TestIndex_EditReplacesAndRemoveLeavesNoCopy(t *testing.T) {
	s := seed(t)
	post(t, s, 1, "ZQX-old text")
	post(t, s, 1, "ZQX-new text") // an edit indexes the message again
	if got := run(t, s, "old", all()); len(got) != 0 {
		t.Errorf("the old words stay findable after an edit: %v", got)
	}
	if got := run(t, s, "new", all()); !reflect.DeepEqual(got, []int64{1}) {
		t.Errorf("the new words are not found: %v", got)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return search.Remove(ctx, d, 1) })
	if got := run(t, s, "ZQX", all()); len(got) != 0 {
		t.Errorf("a removed message is still found: %v", got)
	}
	var n int
	for _, table := range []string{"search_entries", "messages_fts_docsize"} {
		col := map[string]string{"search_entries": "message_id", "messages_fts_docsize": "id"}[table]
		if err := s.Reader.SQL().QueryRow(fmt.Sprintf("SELECT count(*) FROM %s WHERE %s = 1", table, col)).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s holds %d rows for the removed message (err %v)", table, n, err)
		}
	}
}

func TestIndex_AConversationThatLeavesTheTrashLeavesNoWords(t *testing.T) {
	s := seed(t)
	post(t, s, 2, "ZQX-trash")
	dbtest.Exec(t, s, `DELETE FROM conversations WHERE id = 20`) // the cascade of the trash purge
	var n int
	if err := s.Reader.SQL().QueryRow(`SELECT count(*) FROM messages_fts_docsize`).Scan(&n); err != nil || n != 0 {
		t.Errorf("the index still holds %d documents after the conversation was removed (err %v)", n, err)
	}
}

func TestTitles(t *testing.T) {
	sc := all()
	for _, c := range []struct {
		q    string
		want []int64
	}{
		{"runb", []int64{20}},
		{"search filt", []int64{10}},
		{"nothing", nil},
		{`in:"Deploy"`, []int64{20}},
		{"is:ask runbook", nil},
		{"", nil},
	} {
		var got []int64
		for _, v := range search.Titles(search.Parse(c.q), sc) {
			got = append(got, v.ID)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %v, want %v", c.q, got, c.want)
		}
	}
}
