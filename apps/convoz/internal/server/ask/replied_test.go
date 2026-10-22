package ask_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
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
// threads answers the thread questions of the ask module with the message module's SQL, run through d: the ask module may not
// import the message module, so a test states the same rules.
type threads struct{}

func (threads) RepliesAnswered(ctx context.Context, d pdb.DBTX, replies []int64) ([]int64, error) {
	if len(replies) == 0 {
		return nil, nil
	}
	return idsOf(ctx, d, `SELECT r.id FROM messages r WHERE r.id IN (`+marks(len(replies))+`) AND EXISTS (
  SELECT 1 FROM messages m
  WHERE m.conversation_id = r.conversation_id AND m.thread_root_id = r.thread_root_id AND m.id > r.id
    AND m.author_id <> r.author_id AND m.deleted_at IS NULL
) ORDER BY r.id`, anys(replies)...)
}

func (threads) InThread(ctx context.Context, d pdb.DBTX, root int64, ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	return idsOf(ctx, d, `SELECT id FROM messages WHERE id IN (`+marks(len(ids))+`) AND thread_root_id = ? ORDER BY id`, append(anys(ids), root)...)
}

// idsOf runs a query that selects one id column and returns the ids in row order.
func idsOf(ctx context.Context, d pdb.DBTX, query string, args ...any) ([]int64, error) {
	rows, err := d.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// marks is the placeholders of an IN list of n values.
func marks(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func anys(ids []int64) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

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
		if a, err = ask.Get(ctx, d, id); err != nil {
			return err
		}
		list := []ask.Ask{a}
		err = ask.MarkReplyAnswered(ctx, d, threads{}, list)
		a = list[0]
		return err
	})
	return
}

func TestOwnerReplied_KeepsTheOpenAsksOfTheThreadOpenAndRemembersTheReply(t *testing.T) {
	s := world(t)
	cv, inbox, journal := &fakeConversations{open: 4}, &fakeInbox{}, &fakeJournal{}
	p := ask.Ports{Threads: threads{}, Conversations: cv, Inbox: inbox, Journal: journal}
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
	p := ask.Ports{Threads: threads{}, Conversations: &fakeConversations{}, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
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

// post adds a message to thread root of conversation 10: an ask when q is a question, else a text reply.
func post(t *testing.T, s *pdb.Store, id, root, author int64, q string) {
	t.Helper()
	if q == "" {
		dbtest.Exec(t, s, fmt.Sprintf(`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES (%d,10,%d,'text','hm',%d,2)`, id, author, root))
		return
	}
	dbtest.Exec(t, s,
		fmt.Sprintf(`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES (%d,10,%d,'ask','%s',%d,2)`, id, author, q, root),
		fmt.Sprintf(`INSERT INTO asks (message_id, conversation_id, asker_id, question, state, version, created_at, updated_at) VALUES (%d,10,%d,'%s','open',1,2,2)`, id, author, q))
}

func waiting(t *testing.T, s *pdb.Store) (open, replied []int64) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		w, err := ask.ForNow(ctx, d, threads{}, 1, t0, 0)
		for _, a := range w.Open {
			open = append(open, a.ID)
		}
		for _, a := range w.Replied {
			replied = append(replied, a.ID)
		}
		return err
	})
	return
}

func TestForNow_TheAskWaitsOnTheAgentOnlyWhileTheOwnersReplyIsTheLastWordInItsThread(t *testing.T) {
	s := world(t)
	p := ask.Ports{Threads: threads{}, Conversations: &fakeConversations{}, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
	post(t, s, 60, 6, 1, "")
	ownerReplied(t, s, p, 6, 60)
	if open, replied := waiting(t, s); !slices.Equal(replied, []int64{7}) || slices.Contains(open, 7) || !get(t, s, 7).WaitingOnAgent() {
		t.Fatalf("after the owner's reply: open %v, replied %v; want ask 7 replied and waiting on the agent", open, replied)
	}

	post(t, s, 61, 6, 2, "") // the agent answers in the thread but does not update the ask
	if open, replied := waiting(t, s); len(replied) != 0 || !slices.Contains(open, 7) || get(t, s, 7).WaitingOnAgent() {
		t.Errorf("after the agent's answer: open %v, replied %v; want ask 7 back in open and no longer waiting on the agent", open, replied)
	}

	post(t, s, 62, 6, 1, "")
	ownerReplied(t, s, p, 6, 62)
	if _, replied := waiting(t, s); !slices.Equal(replied, []int64{7}) || !get(t, s, 7).WaitingOnAgent() {
		t.Errorf("after the owner's second reply: replied %v, want ask 7 waiting on the agent again", replied)
	}
}

func TestOwnerReplied_OneReplyCountsForOneAskOfASharedThread(t *testing.T) {
	s := world(t)
	post(t, s, 13, 6, 2, "Review 2 of 3?") // a second ask inside thread 6, next to ask 7
	post(t, s, 14, 5, 2, "Review 3 of 3?") // an ask inside the thread of ask 5
	inbox := &fakeInbox{}
	p := ask.Ports{Threads: threads{}, Conversations: &fakeConversations{}, Inbox: inbox, Journal: &fakeJournal{}}
	post(t, s, 60, 6, 1, "")
	ownerReplied(t, s, p, 6, 60)
	post(t, s, 50, 5, 1, "")
	ownerReplied(t, s, p, 5, 50)

	// the root's own ask takes a reply in its thread; inside a thread of a plain message, the newest ask does
	for id, want := range map[int64]int64{5: 50, 14: 0, 7: 0, 13: 60} {
		if got := get(t, s, id).OwnerReplyID; got != want {
			t.Errorf("ask %d remembers reply %d, want %d", id, got, want)
		}
	}
	slices.Sort(inbox.told)
	if !slices.Equal(inbox.told, []int64{5, 13}) {
		t.Errorf("the asking agents were told of %v, want asks 5 and 13", inbox.told)
	}
	_, replied := waiting(t, s)
	slices.Sort(replied)
	if !slices.Equal(replied, []int64{5, 13}) {
		t.Errorf("replied %v, want each reply under one ask: 5 and 13", replied)
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
	p := ask.Ports{Threads: threads{}, Messages: &fakeMessages{}, Conversations: cv, Inbox: &fakeInbox{}, Journal: &fakeJournal{}}
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
