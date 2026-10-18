package message_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	owner, devtool, docs = int64(1), int64(2), int64(3)
	conv                 = int64(10)
)

var t0 = time.Unix(1_800_000_000, 0)

// fakes record what Post asked of the other modules, and stand in for them.
type fakes struct {
	access     message.Access
	prevMain   int64
	moves      bool
	recipients []int64

	recorded, fanned, created, readMoved int
	fannedTo                             []int64
}

func (f *fakes) Access(context.Context, pdb.DBTX, int64) (message.Access, error) {
	return f.access, nil
}
func (f *fakes) NoteAgentPost(context.Context, pdb.DBTX, int64, int64, int64) error { return nil }

func (f *fakes) RecordMainPost(context.Context, pdb.DBTX, time.Time, int64, int64, string) (int64, error) {
	f.recorded++
	return f.prevMain, nil
}
func (f *fakes) AgentRecipients(context.Context, pdb.DBTX, int64, int64) ([]int64, error) {
	return f.recipients, nil
}
func (f *fakes) MoveForOwnPost(context.Context, pdb.DBTX, time.Time, int64, int64, int64, int64) (bool, error) {
	return f.moves, nil
}
func (f *fakes) FanOut(_ context.Context, _ pdb.DBTX, _ time.Time, who int64, _ message.Arrival) error {
	f.fanned++
	f.fannedTo = append(f.fannedTo, who)
	return nil
}
func (f *fakes) MessageCreated(context.Context, pdb.DBTX, time.Time, message.Created) (int64, error) {
	f.created++
	return 77, nil
}
func (f *fakes) ReadMoved(context.Context, pdb.DBTX, time.Time, int64, int64, int64) error {
	f.readMoved++
	return nil
}

func (f *fakes) ports() message.Ports {
	return message.Ports{Conversations: f, Reads: f, Inbox: f, Journal: f}
}

func seeded(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1),(3,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`)
	return s
}

func post(t *testing.T, s *pdb.Store, f *fakes, d message.Draft) (p message.Posted, err error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err = s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		p, err = message.Post(ctx, tx.DBTX(), f.ports(), t0, d)
		return err
	})
	return p, err
}

func draft(clientID, body string) message.Draft {
	return message.Draft{Conversation: conv, Author: owner, ClientID: clientID, Body: body}
}

func TestPostRefusesABodyOrFormatItCannotStore(t *testing.T) {
	s := seeded(t)
	cases := []struct {
		name string
		d    message.Draft
		want error
	}{
		{"empty", draft("client-01", ""), message.ErrEmpty},
		{"only spaces and newlines", draft("client-02", " \n\t "), message.ErrEmpty},
		{"a NUL byte", draft("client-03", "hi\x00there"), message.ErrNUL},
		{"over 16384 bytes", draft("client-04", strings.Repeat("x", message.MaxBodyBytes+1)), message.ErrTooLarge},
		{"an unknown format", message.Draft{Conversation: conv, Author: owner, ClientID: "client-05", Body: "hi", Format: "html"}, message.ErrFormat},
	}
	for _, tc := range cases {
		f := &fakes{}
		if _, err := post(t, s, f, tc.d); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, err, tc.want)
		}
		if f.created+f.recorded != 0 {
			t.Errorf("%s: a refused body writes nothing", tc.name)
		}
	}
	if _, err := post(t, s, &fakes{}, draft("client-06", strings.Repeat("x", message.MaxBodyBytes))); err != nil {
		t.Errorf("exactly 16384 bytes is allowed: %v", err)
	}
}

func TestAMessageOfFilesAloneNeedsNoWordsButAnEmptyOneStillFails(t *testing.T) {
	s := seeded(t)
	files := draft("client-f1", "")
	files.UploadIDs = []string{"aaaaaaaaaaaaaaaaaaaaaa"}
	if _, err := post(t, s, &fakes{}, files); err != nil {
		t.Fatalf("a message of files alone: %v", err)
	}
	files = draft("client-f2", "")
	files.UploadIDs = []string{"aaaaaaaaaaaaaaaaaaaaaa"}
	files.Format = "html"
	if _, err := post(t, s, &fakes{}, files); !errors.Is(err, message.ErrFormat) {
		t.Fatalf("the format still counts: %v", err)
	}
	if _, err := post(t, s, &fakes{}, draft("client-f3", " ")); !errors.Is(err, message.ErrEmpty) {
		t.Fatalf("no files and no words: %v", err)
	}
}

func TestPostStopsBeforeWritingWhenTheCallerMayNotPost(t *testing.T) {
	for access, want := range map[message.Access]error{message.Denied: message.ErrDenied, message.Missing: message.ErrMissing} {
		f := &fakes{access: access}
		if _, err := post(t, seeded(t), f, draft("client-01", "hello")); !errors.Is(err, want) {
			t.Errorf("access %v: %v, want %v", access, err, want)
		}
		if f.created+f.recorded+f.fanned != 0 {
			t.Errorf("access %v: nothing is written", access)
		}
	}
}

func TestPostFansOutToEveryRecipientAndMovesTheCursorOnlyWhenTold(t *testing.T) {
	s := seeded(t)
	f := &fakes{recipients: []int64{devtool, docs}, moves: true, prevMain: 4}
	p, err := post(t, s, f, draft("client-01", "Is the build green?"))
	if err != nil || p.Replayed || p.Message.ID == 0 {
		t.Fatalf("first post: %+v %v", p, err)
	}
	if f.recorded != 1 || f.created != 1 || f.fanned != 2 || f.readMoved != 1 {
		t.Errorf("one record, one event, two items, one cursor move: %+v", f)
	}
	if len(p.Wake) != 2 || p.Wake[0] != devtool || p.Wake[1] != docs {
		t.Errorf("both recipients are woken: %v", p.Wake)
	}

	f = &fakes{moves: false}
	if _, err := post(t, s, f, draft("client-02", "second")); err != nil || f.readMoved != 0 {
		t.Errorf("a cursor that did not move writes no read event: err=%v moved events=%d", err, f.readMoved)
	}
}

func TestPostWithTheSameClientIDReplaysOrConflicts(t *testing.T) {
	s := seeded(t)
	first, err := post(t, s, &fakes{recipients: []int64{devtool}}, draft("client-01", "same"))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakes{recipients: []int64{devtool}}
	again, err := post(t, s, f, draft("client-01", "same"))
	if err != nil || !again.Replayed || again.Message.ID != first.Message.ID {
		t.Errorf("a repeat returns the first message: %+v %v", again, err)
	}
	if f.recorded+f.created+f.fanned != 0 || len(again.Wake) != 0 {
		t.Errorf("a repeat changes and wakes nothing: %+v", f)
	}
	for name, d := range map[string]message.Draft{
		"another body":   draft("client-01", "different"),
		"another format": {Conversation: conv, Author: owner, ClientID: "client-01", Body: "same", Format: "plain"},
	} {
		if _, err := post(t, s, &fakes{}, d); !errors.Is(err, message.ErrClientIDConflict) {
			t.Errorf("%s: %v, want a conflict", name, err)
		}
	}
	// the client id belongs to the author: another author may use the same one
	if _, err := post(t, s, &fakes{}, message.Draft{Conversation: conv, Author: devtool, ClientID: "client-01", Body: "other author"}); err != nil {
		t.Errorf("client ids are per author: %v", err)
	}
}

func TestPagesAreOldestFirstAndNeverShowAboveTheFloor(t *testing.T) {
	s := seeded(t)
	var ids []int64
	for _, c := range []string{"client-01", "client-02", "client-03", "client-04", "client-05"} {
		p, err := post(t, s, &fakes{}, draft(c, "m "+c))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.Message.ID)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		check := func(name string, got []message.Message, want ...int64) {
			t.Helper()
			if len(got) != len(want) {
				t.Errorf("%s: %d messages, want %d", name, len(got), len(want))
				return
			}
			for i, m := range got {
				if m.ID != want[i] {
					t.Errorf("%s: position %d is %d, want %d", name, i, m.ID, want[i])
				}
			}
		}
		page, _ := message.Newest(ctx, d, conv, 0, 3)
		check("newest 3", page, ids[2], ids[3], ids[4])
		page, _ = message.Newest(ctx, d, conv, ids[2], 10)
		check("newest above the floor", page, ids[3], ids[4])
		page, _ = message.Before(ctx, d, conv, ids[3], 0, 2)
		check("before the 4th", page, ids[1], ids[2])
		page, _ = message.After(ctx, d, conv, ids[1], 0, 2)
		check("after the 2nd", page, ids[2], ids[3])
		page, _ = message.After(ctx, d, conv, 0, ids[2], 10)
		check("after nothing, above the floor", page, ids[3], ids[4])
		return nil
	})
}

func TestUnreadCountsOnlyOthersMessagesAfterTheCursor(t *testing.T) {
	s := seeded(t)
	var mine, theirs []int64
	for i, c := range []string{"client-01", "client-02", "client-03"} {
		author := devtool
		if i == 1 {
			author = owner
		}
		p, err := post(t, s, &fakes{}, message.Draft{Conversation: conv, Author: author, ClientID: c, Body: "m"})
		if err != nil {
			t.Fatal(err)
		}
		if author == owner {
			mine = append(mine, p.Message.ID)
		} else {
			theirs = append(theirs, p.Message.ID)
		}
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		// the owner's own message in the middle is never unread for the owner
		if n, err := message.CountUnread(ctx, d, conv, 0, owner); err != nil || n != 2 {
			t.Errorf("unread from the start: %d %v, want 2", n, err)
		}
		if n, _ := message.CountUnread(ctx, d, conv, mine[0], owner); n != 1 {
			t.Errorf("unread after the owner's own message: %d, want 1", n)
		}
		if n, _ := message.CountUnread(ctx, d, conv, theirs[1], owner); n != 0 {
			t.Errorf("caught up: %d, want 0", n)
		}
		return nil
	})
}

func TestPreviewIsOneLineOfAtMost140Runes(t *testing.T) {
	if got := message.Preview("a\n\n  b\tc"); got != "a b c" {
		t.Errorf("whitespace folds: %q", got)
	}
	if got := message.Preview(strings.Repeat("é", 200)); got != strings.Repeat("é", message.PreviewRunes) {
		t.Errorf("cut at 140 runes: %d bytes", len(got))
	}
}

func TestPreviewIsPlainText(t *testing.T) {
	for in, want := range map[string]string{
		"**bold** and *it* and _it_ and snake_case": "bold and it and it and snake_case",
		"run `go test` now":                         "run go test now",
		"see [the docs](https://x.example/a) ok":    "see the docs ok",
		"# Title\n- one\n2. two\n> quoted":          "Title one two quoted",
		"before\n```go\nx := 1\n```\nafter":         "before code after",
		"open ```fence never closed":                "open code",
		"a\u202eb\u200bc":                           "abc",
	} {
		if got := message.Preview(in); got != want {
			t.Errorf("Preview(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClampLimit(t *testing.T) {
	for in, want := range map[int]int{-5: message.DefaultPage, 0: message.DefaultPage, 1: 1, 100: 100, 101: message.MaxPage, 5000: message.MaxPage} {
		if got := message.ClampLimit(in); got != want {
			t.Errorf("ClampLimit(%d) = %d, want %d", in, got, want)
		}
	}
}
