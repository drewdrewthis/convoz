package ask_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

var t0 = time.Unix(1_800_000_000, 0)

// fakes record what closing an ask tells the other modules; the ask module owns the rest.
type fakeConversations struct{ open int64 }

func (f *fakeConversations) AddOpenAsks(_ context.Context, _ pdb.DBTX, _, delta int64) error {
	f.open += delta
	return nil
}
func (*fakeConversations) AskerActive(context.Context, pdb.DBTX, int64, int64) (bool, error) {
	return true, nil
}

type fakeInbox struct{ told []int64 }

func (f *fakeInbox) AskResolved(_ context.Context, _ pdb.DBTX, _ time.Time, _, _, askMessage, _ int64) error {
	f.told = append(f.told, askMessage)
	return nil
}

type fakeJournal struct{ reasons []any }

func (f *fakeJournal) Write(_ context.Context, _ pdb.DBTX, _ time.Time, c ask.Change) (int64, error) {
	f.reasons = append(f.reasons, c.Payload["reason"])
	return 1, nil
}

// world: conversation 10; ask 5 in the main list (a thread root of its own), ask 7 asked inside thread 6, ask 9 asked inside thread 8,
// ask 11 in the main list and snoozed; asks 5 and 7 are devtool's, 9 and 11 are docs'. Ask 12 is dismissed.
func world(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	stmts := []string{
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
			(1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1),(3,'agent','docs','D','docs','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (6,10,1,'text','root six',1),(8,10,1,'text','root eight',1)`,
	}
	for _, a := range []struct{ id, thread, asker int }{{5, 0, 2}, {7, 6, 2}, {9, 8, 3}, {11, 0, 3}, {12, 0, 2}} {
		thread := "NULL"
		if a.thread != 0 {
			thread = fmt.Sprint(a.thread)
		}
		stmts = append(stmts,
			fmt.Sprintf(`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES (%d,10,%d,'ask','Merge it?',%s,1)`, a.id, a.asker, thread),
			fmt.Sprintf(`INSERT INTO asks (message_id, conversation_id, asker_id, question, state, version, created_at, updated_at) VALUES (%d,10,%d,'Merge it?','open',1,1,1)`, a.id, a.asker))
	}
	stmts = append(stmts,
		`INSERT INTO ask_snoozes (message_id, identity_id, until_at, created_at) VALUES (11,1,99,1)`,
		`UPDATE asks SET state='dismissed', resolved_by=1, resolved_at=1 WHERE message_id=12`)
	dbtest.Exec(t, s, stmts...)
	return s
}

func state(t *testing.T, s *pdb.Store, id int64) (st, reason string) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		a, err := ask.Get(ctx, d, id)
		st, reason = a.State, a.CloseReason
		return err
	})
	return
}

func TestCloseForReply_ClosesTheOpenAsksOfTheThread(t *testing.T) {
	s := world(t)
	cv, inbox, journal := &fakeConversations{open: 4}, &fakeInbox{}, &fakeJournal{}
	p := ask.Ports{Conversations: cv, Inbox: inbox, Journal: journal}
	for name, root := range map[string]int64{"the ask's own thread": 5, "the thread the ask was asked in": 6, "a snoozed ask's thread": 11} {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return ask.CloseForReply(ctx, d, p, t0, 10, root) })
		var id int64
		switch root {
		case 5:
			id = 5
		case 6:
			id = 7
		case 11:
			id = 11
		}
		if st, why := state(t, s, id); st != "closed" || why != ask.ReasonReplied {
			t.Errorf("%s: ask %d is %s (%s), want closed (replied)", name, id, st, why)
		}
	}
	slices.Sort(inbox.told) // the cases above run in map order
	if !slices.Equal(inbox.told, []int64{5, 7, 11}) {
		t.Errorf("the asking agents were told of %v, want asks 5, 7 and 11", inbox.told)
	}
	if cv.open != 1 {
		t.Errorf("open ask counter = %d, want 4-3", cv.open)
	}
	if st, _ := state(t, s, 11); st != "closed" {
		t.Errorf("a snoozed ask must close too")
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var n int
		if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM ask_snoozes`).Scan(&n); err != nil || n != 0 {
			t.Errorf("the snooze of a closed ask stays: %d %v", n, err)
		}
		return nil
	})
}

func TestCloseForReply_LeavesOtherThreadsAndSettledAsksAlone(t *testing.T) {
	s := world(t)
	p := ask.Ports{Conversations: &fakeConversations{}, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return ask.CloseForReply(ctx, d, p, t0, 10, 6) })
	for id, want := range map[int64]string{5: "open", 7: "closed", 9: "open", 11: "open"} {
		if st, _ := state(t, s, id); st != want {
			t.Errorf("ask %d is %s, want %s", id, st, want)
		}
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return ask.CloseForReply(ctx, d, p, t0, 10, 12) })
	if st, _ := state(t, s, 12); st != "dismissed" {
		t.Errorf("a dismissed ask was already resolved for its agent, got %s", st)
	}
}
