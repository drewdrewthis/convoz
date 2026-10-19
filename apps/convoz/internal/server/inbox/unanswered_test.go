package inbox_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

var (
	mainChat = inbox.Place{Conversation: conv1}
	thread   = inbox.Place{Conversation: conv1, ThreadRoot: 5}
)

func due(t *testing.T, s *pdb.Store, at time.Time) (out []inbox.Reminder) {
	t.Helper()
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		var err error
		if out, err = inbox.Due(ctx, d, at); err != nil {
			t.Fatal(err)
		}
	})
	return out
}

func spoke(t *testing.T, s *pdb.Store, p inbox.Place, msg int64, at time.Time) {
	t.Helper()
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if err := inbox.OwnerSpoke(ctx, d, p, msg, at.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestAPlaceIsDueTenMinutesAfterTheOwnersMessage(t *testing.T) {
	s := seeded(t)
	spoke(t, s, mainChat, 7, t0)
	if got := due(t, s, t0.Add(inbox.UnansweredAfter-time.Millisecond)); len(got) != 0 {
		t.Fatalf("not due before 10 minutes: %+v", got)
	}
	got := due(t, s, t0.Add(inbox.UnansweredAfter))
	if len(got) != 1 || got[0].Place != mainChat || got[0].Message != 7 {
		t.Fatalf("due at 10 minutes, with the owner's message: %+v", got)
	}
}

func TestANewerOwnerMessageOfThePlaceRestartsTheWait(t *testing.T) {
	s := seeded(t)
	spoke(t, s, mainChat, 7, t0)
	spoke(t, s, mainChat, 8, t0.Add(6*time.Minute))
	got := due(t, s, t0.Add(12*time.Minute))
	if len(got) != 0 {
		t.Fatalf("the old message never fires: %+v", got)
	}
	got = due(t, s, t0.Add(16*time.Minute))
	if len(got) != 1 || got[0].Message != 8 {
		t.Fatalf("the newer message fires 10 minutes after itself: %+v", got)
	}
}

func TestAnAnswerClearsOnlyItsOwnPlace(t *testing.T) {
	s := seeded(t)
	spoke(t, s, mainChat, 7, t0)
	spoke(t, s, thread, 9, t0)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if err := inbox.Answered(ctx, d, mainChat); err != nil {
			t.Fatal(err)
		}
	})
	got := due(t, s, t0.Add(time.Hour))
	if len(got) != 1 || got[0].Place != thread {
		t.Fatalf("the main chat is answered, the thread still waits: %+v", got)
	}
}

func TestAReminderIsSentOnceAndNeverDroppedByARestart(t *testing.T) {
	s := seeded(t)
	spoke(t, s, mainChat, 7, t0)
	at := t0.Add(11 * time.Minute)
	// A restart between the sweep that finds the place and the one that sends: the row is still there, so nothing is lost.
	if len(due(t, s, at)) != 1 || len(due(t, s, at)) != 1 {
		t.Fatal("a place stays due until it is reminded")
	}
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		r := inbox.Reminder{Place: mainChat, Message: 7}
		if err := inbox.Remind(ctx, d, at, devtool, r); err != nil {
			t.Fatal(err)
		}
		if err := inbox.Reminded(ctx, d, r.Place); err != nil {
			t.Fatal(err)
		}
	})
	if got := due(t, s, at.Add(time.Hour)); len(got) != 0 {
		t.Fatalf("a reminded place is not due again: %+v", got)
	}
	items := claim(t, s, at, sessA, false)
	if len(items) != 1 || items[0].Reason != inbox.ReasonUnanswered || items[0].MessageID != 7 || items[0].ConversationID != conv1 {
		t.Fatalf("the agent gets one unanswered item that carries the owner's message: %+v", items)
	}
}

func TestDueListsOldestFirst(t *testing.T) {
	s := seeded(t)
	spoke(t, s, thread, 9, t0.Add(time.Minute))
	spoke(t, s, mainChat, 7, t0)
	got := due(t, s, t0.Add(time.Hour))
	if len(got) != 2 || got[0].Place != mainChat || got[1].Place != thread {
		t.Fatalf("oldest first: %+v", got)
	}
}

func TestAWatchThatGotAnAnswerFinishesItsItems(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	items := claim(t, s, t0, sessA, false)
	if len(items) != 1 {
		t.Fatalf("claimed: %+v", items)
	}
	var done []int64
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		cursor, err := inbox.Cursor(ctx, d, devtool)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := inbox.AckThrough(ctx, d, t0, devtool, sessB, cursor); err != nil { // another session's claim is not finished
			t.Fatal(err)
		}
		if done, err = inbox.AckThrough(ctx, d, t0, devtool, sessA, cursor-1); err != nil || len(done) != 0 {
			t.Fatalf("a cursor below the claim finishes nothing: %v %v", done, err)
		}
		if done, err = inbox.AckThrough(ctx, d, t0, devtool, sessA, cursor); err != nil {
			t.Fatal(err)
		}
	})
	if !slices.Equal(done, []int64{items[0].ID}) {
		t.Fatalf("the claim up to the cursor is finished: %v", done)
	}
	if again := claim(t, s, t0.Add(inbox.DefaultVisibility+time.Minute), sessA, false); len(again) != 0 {
		t.Fatalf("a finished item is not delivered again after the claim time: %+v", again)
	}
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		ok, _, err := inbox.Ack(ctx, d, t0, devtool, sessA, items[0].ID, items[0].ClaimToken)
		if err != nil || !ok {
			t.Fatalf("an ack of a finished item succeeds as a no-op: %v %v", ok, err)
		}
	})
}

func TestTargets(t *testing.T) {
	agents := []int64{3, 4, 5}
	tests := []struct {
		name               string
		mentioned, posters []int64
		thread             bool
		want               []int64
	}{
		{"mention: only the mentioned agent", []int64{4}, nil, false, []int64{4}},
		{"mention beats thread posters", []int64{5}, []int64{3}, true, []int64{5}},
		{"a mention of someone who is no agent here falls back", []int64{99}, nil, false, []int64{3, 4, 5}},
		{"main chat, no mention: every agent", nil, nil, false, []int64{3, 4, 5}},
		{"thread, no mention: the agents who posted in it", nil, []int64{1, 5}, true, []int64{5}},
		{"thread, no agent posted: every agent", nil, []int64{1}, true, []int64{3, 4, 5}},
		{"posters count only in a thread", nil, []int64{5}, false, []int64{3, 4, 5}},
	}
	for _, tc := range tests {
		if got := inbox.Targets(agents, tc.mentioned, tc.posters, tc.thread); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
	if got := inbox.Targets(nil, []int64{4}, nil, false); len(got) != 0 {
		t.Errorf("no agent, no target: %v", got)
	}
}
