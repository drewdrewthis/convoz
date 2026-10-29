package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// An agent takes a question of the owner: an item on his message (conv 179 msg 12472, 12583, 12591). The answer is a reply in the thread
// plus done. The owner's reply closes every open item on the message; an agent's plain reply reopens them; the owner of an open item is woken.

func (r *wakeRig) take(t *testing.T, who, session, msg int64, in wire.TakeRequest) ([]item.Item, error) {
	t.Helper()
	var out []item.Item
	err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		out, e = r.s.takeMessage(ctx, tx.DBTX(), r.agent(who, session), time.Now(), msg, in)
		return e
	})
	return out, err
}

func (r *wakeRig) answer(t *testing.T, who, session int64, key, text string) (item.Item, []int64, error) {
	t.Helper()
	var it item.Item
	var wake []int64
	err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, wake, e = r.s.answerItem(ctx, tx.DBTX(), r.agent(who, session), time.Now(), r.conv, key, text)
		return e
	})
	return it, wake, err
}

func (r *wakeRig) threadBodies(t *testing.T, root int64) []string {
	t.Helper()
	rows, err := r.s.Store.Reader.SQL().Query(`SELECT body FROM messages WHERE thread_root_id = ? ORDER BY id`, root)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var b string
		_ = rows.Scan(&b)
		out = append(out, b)
	}
	return out
}

func (r *wakeRig) messages(t *testing.T) int {
	t.Helper()
	var n int
	_ = r.s.Store.Reader.SQL().QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, r.conv).Scan(&n)
	return n
}

func TestTakingAQuestionMakesAStartedItemOnHisMessageAndPostsNothing(t *testing.T) {
	r := newWakeRig(t)
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "Why is the search slow? And who owns billing?")
	before := r.messages(t)
	got, err := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Why is the search slow", Context: "He asked in the main chat", Steps: []string{"Profile the query"}})
	if err != nil || len(got) != 2 {
		t.Fatalf("take: %v %d", err, len(got))
	}
	q, step := got[0], got[1]
	if q.State != item.Started || q.ThreadRoot != m || q.Title != "Why is the search slow" || q.Agent != wakeA || q.Plan != "main" {
		t.Fatalf("question: %+v", q)
	}
	if step.State != item.Pending || step.ThreadRoot != m || step.Seq <= q.Seq || r.messages(t) != before {
		t.Fatalf("step %+v, messages %d -> %d", step, before, r.messages(t))
	}
}

func TestOnlyAPersonsMainMessageCanBeTaken(t *testing.T) {
	r := newWakeRig(t)
	agentMsg, _ := r.post(t, wakeB, 9002, 0, "Status update")
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "A question")
	reply, _ := r.post(t, r.ownerID(), wakeOwnerSession, m, "A reply in the thread")
	for _, id := range []int64{agentMsg, reply} {
		if _, err := r.take(t, wakeA, 9001, id, wire.TakeRequest{Question: "Q", Context: "C"}); !errors.Is(err, errTakeTarget) {
			t.Errorf("message %d: %v", id, err)
		}
	}
	if _, err := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Q"}); !errors.Is(err, item.ErrText) {
		t.Errorf("no context: %v", err)
	}
}

func TestASecondTakeNeedsItsOwnQuestion(t *testing.T) {
	r := newWakeRig(t)
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "Why slow")
	if got, err := r.take(t, wakeA, 9001, m, wire.TakeRequest{Context: "C"}); err != nil || got[0].Title != "Why slow" {
		t.Fatalf("no question takes the message text as the title: %v %+v", err, got)
	}
	if _, err := r.take(t, wakeA, 9001, m, wire.TakeRequest{Context: "C"}); !errors.Is(err, item.ErrConflict) {
		t.Fatalf("second take without a question: %v", err)
	}
	got, err := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "And who owns billing", Context: "C"})
	if err != nil || got[0].Title != "And who owns billing" || got[0].Key == "" {
		t.Fatalf("second question: %v %+v", err, got)
	}
}

func TestTheOwnersReplyClosesEveryOpenItemOnTheMessageAndAnAnswerReopensOnlyItsOwn(t *testing.T) {
	r := newWakeRig(t)
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "Q1 and Q2")
	q1, _ := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Q1", Context: "C"})
	q2, _ := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Q2", Context: "C"})
	r.post(t, r.ownerID(), wakeOwnerSession, m, "Thanks, take your time")
	if r.itemRow(t, q1[0].ID).AckedAt == 0 || r.itemRow(t, q2[0].ID).AckedAt == 0 {
		t.Fatal("his reply in the thread closes both items")
	}
	done, wake, err := r.answer(t, wakeA, 9001, q1[0].Key, "Because the index is missing")
	if err != nil || done.State != item.Done || done.AckedAt != 0 {
		t.Fatalf("answer: %v %+v", err, done)
	}
	_ = wake
	if got := r.threadBodies(t, m); got[len(got)-1] != "> Q1\n\nBecause the index is missing" {
		t.Fatalf("thread %q", got)
	}
	if r.itemRow(t, q2[0].ID).AckedAt == 0 {
		t.Fatal("an answer to Q1 leaves Q2 closed")
	}
	r.post(t, wakeA, 9001, m, "Also, Q2 is about billing")
	if r.itemRow(t, q2[0].ID).AckedAt != 0 {
		t.Fatal("a plain agent reply reopens Q2")
	}
}

func TestAnAnswerNeedsAStartedItemWithAMessage(t *testing.T) {
	r := newWakeRig(t)
	plain := r.newItem(t, "legacy") // blocking, no root
	if _, _, err := r.answer(t, wakeA, 9001, plain.Key, "x"); !errors.Is(err, item.ErrConflict) {
		t.Fatalf("legacy item: %v", err)
	}
	if _, _, err := r.answer(t, wakeA, 9001, "nope", "x"); !errors.Is(err, item.ErrNotFound) {
		t.Fatalf("unknown key: %v", err)
	}
}

func TestAnotherAgentsReplyWakesTheOwnerOfAnOpenItemOnly(t *testing.T) {
	r := newWakeRig(t)
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "Q")
	q, _ := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Q", Context: "C"})
	_, wake := r.post(t, wakeB, 9002, m, "I know this one")
	if len(r.reasonsOf(t, wakeA)) != 1 || !containsID(wake, wakeA) {
		t.Fatalf("the owner of the open item is woken: %v %v", r.reasonsOf(t, wakeA), wake)
	}
	if _, err := r.takeMove(t, wakeB, 9002, q[0].Key); !errors.Is(err, item.ErrNotFound) {
		t.Fatalf("only the owner moves it: %v", err)
	}
	// After his Okay (a reply), B's reply wakes nobody new.
	r.post(t, r.ownerID(), wakeOwnerSession, m, "Okay")
	r.post(t, wakeB, 9002, m, "More detail")
	if n := len(r.reasonsOf(t, wakeA)); n != 1 {
		t.Fatalf("an acked item wakes nobody: %d", n)
	}
	// The poster is never woken by her own reply.
	_, wake = r.post(t, wakeA, 9001, m, "Thanks B")
	if containsID(wake, wakeA) {
		t.Fatal("the poster is not woken")
	}
}

func (r *wakeRig) takeMove(t *testing.T, who, session int64, key string) (item.Item, error) {
	t.Helper()
	var it item.Item
	err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, e = item.MarkDone(ctx, tx.DBTX(), time.Now(), who, r.conv, key, "")
		return e
	})
	return it, err
}

func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestOkayOnABlockedQuestionReturnsItToStarted(t *testing.T) {
	r := newWakeRig(t)
	m, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "Q")
	q, _ := r.take(t, wakeA, 9001, m, wire.TakeRequest{Question: "Which db", Context: "C"})
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		_, err := item.Block(ctx, tx.DBTX(), time.Now(), wakeA, r.conv, q[0].Key, item.Fields{Title: "Which db", Context: "I need you"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		_, err := item.GotIt(ctx, tx.DBTX(), time.Now(), r.ownerID(), q[0].ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if row := r.itemRow(t, q[0].ID); row.State != item.Started || row.OwnerStep {
		t.Fatalf("a question's blocker goes back to started: %+v", row)
	}
}

func (r *wakeRig) agent(who, session int64) *call {
	return &call{p: authz.Principal{Authenticated: true, SessionID: session, IdentityID: who, Role: "agent"}, dev: r.c.dev, human: r.c.human}
}
