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

func ownerReplied(t *testing.T, s *pdb.Store, p ask.Ports, root, reply int64) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		return ask.OwnerReplied(ctx, d, p, t0, 10, root, reply, 1)
	})
}

func get(t *testing.T, s *pdb.Store, id int64) (a ask.Ask) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		a, err = ask.Get(ctx, d, id)
		return err
	})
	return
}

func TestOwnerReplied_KeepsTheOpenAsksOfTheThreadOpenAndRemembersTheReply(t *testing.T) {
	s := world(t)
	cv, inbox, journal := &fakeConversations{open: 4}, &fakeInbox{}, &fakeJournal{}
	p := ask.Ports{Conversations: cv, Inbox: inbox, Journal: journal}
	for reply, root := range map[int64]int64{50: 5, 60: 6, 110: 11} { // the ask's own thread, the thread it was asked in, a snoozed ask's thread
		ownerReplied(t, s, p, root, reply)
	}
	for id, reply := range map[int64]int64{5: 50, 7: 60, 11: 110} {
		a := get(t, s, id)
		if a.State != ask.Open || a.OwnerReplyID != reply || a.OwnerRepliedAt != t0.UnixMilli() {
			t.Errorf("ask %d is %s, reply %d at %d; want open with reply %d", id, a.State, a.OwnerReplyID, a.OwnerRepliedAt, reply)
		}
		if h := a.History[len(a.History)-1]; h.Event != "owner_replied" || h.ToState != ask.Open {
			t.Errorf("ask %d: last history row is %+v, want owner_replied while open", id, h)
		}
	}
	slices.Sort(inbox.told)
	if !slices.Equal(inbox.told, []int64{5, 7, 11}) {
		t.Errorf("the asking agents were told of %v, want asks 5, 7 and 11", inbox.told)
	}
	if cv.open != 4 {
		t.Errorf("open ask counter = %d, want it unchanged at 4", cv.open)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var n int
		if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM ask_snoozes`).Scan(&n); err != nil || n != 1 {
			t.Errorf("the snooze of a replied ask must stay: %d %v", n, err)
		}
		return nil
	})
}

func TestOwnerReplied_LeavesOtherThreadsAndSettledAsksAlone(t *testing.T) {
	s := world(t)
	p := ask.Ports{Conversations: &fakeConversations{}, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
	ownerReplied(t, s, p, 6, 60)
	ownerReplied(t, s, p, 12, 120)
	for id, want := range map[int64]int64{5: 0, 7: 60, 9: 0, 11: 0, 12: 0} {
		if got := get(t, s, id).OwnerReplyID; got != want {
			t.Errorf("ask %d remembers reply %d, want %d", id, got, want)
		}
	}
	if st, _ := state(t, s, 12); st != "dismissed" {
		t.Errorf("a dismissed ask was already resolved for its agent, got %s", st)
	}
}

type fakeMessages struct{}

func (*fakeMessages) PostAsk(context.Context, pdb.DBTX, time.Time, ask.AskMessage) (int64, bool, error) {
	return 0, false, nil
}
func (*fakeMessages) SetQuestion(context.Context, pdb.DBTX, time.Time, int64, string) error {
	return nil
}
func (*fakeMessages) PostAnswer(context.Context, pdb.DBTX, time.Time, ask.AnswerMessage) error {
	return nil
}

func TestUpdate_ChangesTheAskInPlaceAfterTheOwnersQuestions(t *testing.T) {
	s := world(t)
	cv := &fakeConversations{open: 4}
	p := ask.Ports{Messages: &fakeMessages{}, Conversations: cv, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
	ownerReplied(t, s, p, 6, 60)
	update := func(in ask.Updating) (a ask.Ask, err error) {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { a, err = ask.Update(ctx, d, p, t0, in); return nil })
		return
	}

	if _, err := update(ask.Updating{ID: 7, By: 2, Question: "Merge it, now?"}); err == nil {
		t.Error("an update after the owner's reply must carry answers")
	}
	if _, err := update(ask.Updating{ID: 7, By: 3, Answers: "x"}); err != ask.ErrNotAsker {
		t.Errorf("another agent updated the ask: %v", err)
	}
	if _, err := update(ask.Updating{ID: 12, By: 2, Answers: "x"}); err == nil {
		t.Error("a dismissed ask is not open: its update must be refused")
	}
	a, err := update(ask.Updating{
		ID: 7, By: 2, Question: "Merge it, now?", Answers: "Behind a flag; the review bot passed.",
		Recommended: &ask.Option{Label: "Yes", Why: "Green"}, Alternatives: []ask.Option{{Label: "No", Why: "Wait"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	last := a.History[len(a.History)-1]
	if a.State != ask.Open || a.OwnerRepliedAt != 0 || a.Question != "Merge it, now?" || a.Answers != "Behind a flag; the review bot passed." || a.Changed != "question, options" ||
		len(a.Options) != 2 || last.Event != "updated" || cv.open != 4 {
		t.Errorf("updated ask = %+v (history %+v, counter %d)", a, last, cv.open)
	}
}
