package conversation_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	owner, devtool, docs = int64(1), int64(2), int64(3)
)

var t0 = time.Unix(1_800_000_000, 0)

func seeded(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1),(3,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`)
	return s
}

func create(t *testing.T, s *pdb.Store, at time.Time, in conversation.New) (c conversation.Conversation) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		c, err = conversation.Create(ctx, d, at, in)
		return err
	})
	return c
}

func TestValidTitleBoundsAndControlCharacters(t *testing.T) {
	cases := map[string]bool{
		"":                         false,
		"a":                        true,
		strings.Repeat("é", 120):   true,
		strings.Repeat("é", 121):   false,
		"line\nbreak":              false,
		"bell\x07":                 false,
		"plain title with spaces":  true,
		strings.Repeat("a", 120+1): false,
	}
	for title, want := range cases {
		if got := conversation.ValidTitle(title); got != want {
			t.Errorf("ValidTitle(%.20q) = %v, want %v", title, got, want)
		}
	}
}

func TestAutoTitleIsTheFirst60RunesOnOneLine(t *testing.T) {
	if got := conversation.AutoTitle("  Is the\n\nbuild   green? "); got != "Is the build green?" {
		t.Errorf("whitespace folds to single spaces: %q", got)
	}
	if got := conversation.AutoTitle(strings.Repeat("é", 100)); got != strings.Repeat("é", 60) {
		t.Errorf("cut at 60 runes, not bytes: %q", got)
	}
	if got := conversation.AutoTitle(" \n\t"); got != "" {
		t.Errorf("no visible text gives no title: %q", got)
	}
}

func TestCreateAddsTheCreatorOnceAndEveryMemberAtOnce(t *testing.T) {
	s := seeded(t)
	c := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool, owner, devtool, docs}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		parts, err := conversation.Participants(ctx, d, c.ID)
		if err != nil {
			return err
		}
		if len(parts) != 3 {
			t.Errorf("owner, devtool and docs once each, got %+v", parts)
		}
		m, found, err := conversation.Membership(ctx, d, c.ID, devtool)
		if err != nil || !found || !m.Active || m.JoinedMessageID != 0 {
			t.Errorf("an added agent is active with full history: %+v found=%v err=%v", m, found, err)
		}
		if _, found, _ := conversation.Membership(ctx, d, c.ID+99, devtool); found {
			t.Error("no standing in a conversation that does not exist")
		}
		return nil
	})
}

func TestRecordMainPostReturnsThePreviousMainAndNamesOnlyANamelessConversation(t *testing.T) {
	s := seeded(t)
	nameless := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	titled := create(t, s, t0, conversation.New{By: owner, Title: "Chosen", Members: []int64{devtool}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		// message rows are the message module's; the counters need only an id, and the FK is not touched by this update
		for _, tc := range []struct {
			id   int64
			want string
		}{{nameless.ID, "First message"}, {titled.ID, "Chosen"}} {
			prev, err := conversation.RecordMainPost(ctx, d, t0.Add(time.Minute), tc.id, 7, "First message")
			if err != nil || prev != 0 {
				t.Fatalf("the first post sees no earlier main message: prev=%d err=%v", prev, err)
			}
			prev, err = conversation.RecordMainPost(ctx, d, t0.Add(2*time.Minute), tc.id, 9, "Second")
			if err != nil || prev != 7 {
				t.Fatalf("the second post sees the first as the previous main: prev=%d err=%v", prev, err)
			}
			c, _, _ := conversation.Get(ctx, d, tc.id)
			if c.Title != tc.want || c.LastMainID != 9 || c.LastMessageID != 9 || c.MessageCount != 2 {
				t.Errorf("conversation %d after two posts: %+v, want title %q", tc.id, c, tc.want)
			}
		}
		return nil
	})
}

func TestListsAreLatestActivityFirstAndAnAgentSeesOnlyItsOwn(t *testing.T) {
	s := seeded(t)
	older := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	newer := create(t, s, t0.Add(time.Minute), conversation.New{By: owner, Members: []int64{devtool}})
	other := create(t, s, t0.Add(2*time.Minute), conversation.New{By: owner, Members: []int64{docs}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if _, err := conversation.RecordMainPost(ctx, d, t0.Add(10*time.Minute), older.ID, 5, "bump"); err != nil {
			return err
		}
		all, err := conversation.ListAll(ctx, d)
		if err != nil {
			return err
		}
		if ids(all) != [3]int64{older.ID, other.ID, newer.ID} {
			t.Errorf("owner order is activity, not creation: %v", ids(all))
		}
		mine, err := conversation.ListOf(ctx, d, devtool)
		if err != nil {
			return err
		}
		if len(mine) != 2 || mine[0].ID != older.ID || mine[1].ID != newer.ID {
			t.Errorf("devtool sees its two, latest activity first: %+v", mine)
		}
		return nil
	})
}

func ids(list []conversation.Conversation) (out [3]int64) {
	for i, c := range list {
		if i < len(out) {
			out[i] = c.ID
		}
	}
	return out
}
