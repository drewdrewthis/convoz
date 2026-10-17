package inbox_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	devtool            = int64(2)
	conv1, conv2       = int64(10), int64(11)
	sessA, sessB       = int64(100), int64(101)
	leaseEnd     int64 = 1 << 60
)

var t0 = time.Unix(1_800_000_000, 0)

func seeded(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1),(11,1,1,1)`,
		`INSERT INTO machines (id, name, key_hash, key_enc, key_dek_id, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at)
		   VALUES (1,'box-2',zeroblob(32),zeroblob(8),1,'cvz_m_x',127,'any',1,1,1)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (100,2,1,zeroblob(32),'client-aaaa','a',127,1,1,9999999999999)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (101,2,1,randomblob(32),'client-bbbb','b',127,1,1,9999999999999)`)
	return s
}

func run(t *testing.T, s *pdb.Store, fn func(ctx context.Context, d pdb.DBTX)) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { fn(ctx, d); return nil })
}

func fan(t *testing.T, s *pdb.Store, at time.Time, conv, msg int64) {
	t.Helper()
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if err := inbox.FanOut(ctx, d, at, devtool, conv, msg, msg, 0, inbox.ReasonActivity); err != nil {
			t.Fatal(err)
		}
	})
}

func claim(t *testing.T, s *pdb.Store, at time.Time, session int64, held bool) (items []inbox.Item) {
	t.Helper()
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		var err error
		if items, err = inbox.Claim(ctx, d, at, inbox.Request{Identity: devtool, Session: session, N: inbox.MaxClaim, IncludeHeld: held}); err != nil {
			t.Fatal(err)
		}
	})
	return items
}

func TestMessagesInOneConversationShareOneReadyItem(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	fan(t, s, t0, conv1, 2)
	fan(t, s, t0, conv2, 3)
	items := claim(t, s, t0, sessA, false)
	if len(items) != 2 {
		t.Fatalf("two conversations, two items: %+v", items)
	}
	first := items[0]
	if first.ConversationID != conv1 || first.Count != 2 || first.FirstMessageID != 1 || first.MessageID != 2 || first.Reason != "activity" {
		t.Errorf("the item holds the range 1..2 and counts 2: %+v", first)
	}
}

func TestAClaimGetsATokenAndEndsAfterTheVisibilityTime(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	got := claim(t, s, t0, sessA, false)
	if len(got) != 1 || len(got[0].ClaimToken) != 16 || got[0].State != "claimed" {
		t.Fatalf("one claimed item with a 16-byte token: %+v", got)
	}
	if want := t0.Add(inbox.DefaultVisibility).UnixMilli(); got[0].ClaimUntil != want {
		t.Errorf("the claim ends at now + the default visibility: %d, want %d", got[0].ClaimUntil, want)
	}
	if again := claim(t, s, t0.Add(time.Second), sessA, false); len(again) != 0 {
		t.Errorf("a held item is not claimed again when held items are not asked for: %+v", again)
	}
}

func TestAHeldItemComesBackWithTheSameTokenAndIsNotANewDelivery(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	first := claim(t, s, t0, sessA, true)
	again := claim(t, s, t0.Add(time.Minute), sessA, true)
	if len(again) != 1 || !again[0].Held || !bytes.Equal(again[0].ClaimToken, first[0].ClaimToken) || again[0].ClaimUntil != first[0].ClaimUntil {
		t.Errorf("same item, same token, same end: %+v vs %+v", again, first)
	}
}

func TestAnotherSessionCannotTakeAConversationWhileAClaimLives(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	claim(t, s, t0, sessA, false)
	fan(t, s, t0.Add(time.Second), conv1, 2) // a new ready item for the same conversation
	if got := claim(t, s, t0.Add(2*time.Second), sessB, false); len(got) != 0 {
		t.Errorf("one session at a time per conversation: %+v", got)
	}
	got := claim(t, s, t0.Add(inbox.DefaultVisibility+time.Second), sessB, false)
	if len(got) != 1 || got[0].Count != 2 || got[0].FirstMessageID != 1 || got[0].MessageID != 2 {
		t.Errorf("after the claim ran out the two items merge into one range 1..2: %+v", got)
	}
}

func TestAnExpiredClaimIsReadyAgainWithANewToken(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	first := claim(t, s, t0, sessA, true)
	later := t0.Add(inbox.DefaultVisibility + time.Second)
	got := claim(t, s, later, sessB, true)
	if len(got) != 1 || got[0].Held || bytes.Equal(got[0].ClaimToken, first[0].ClaimToken) {
		t.Errorf("another session gets the item with a new token: %+v", got)
	}
}

func TestAnItemDeliveredFiveTimesLeavesTheQueue(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	at := t0
	for range 5 {
		if got := claim(t, s, at, sessA, false); len(got) != 1 {
			t.Fatalf("delivery: %+v", got)
		}
		at = at.Add(inbox.DefaultVisibility + time.Second)
	}
	if got := claim(t, s, at, sessA, true); len(got) != 0 {
		t.Errorf("the sixth delivery never happens: %+v", got)
	}
}

func TestAckNeedsTheRightTokenAndSessionAndWorksOnce(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	item := claim(t, s, t0, sessA, false)[0]
	wrong := bytes.Repeat([]byte{1}, 16)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		for name, tc := range map[string]struct {
			session int64
			token   []byte
		}{"wrong token": {sessA, wrong}, "other session": {sessB, item.ClaimToken}} {
			if ok, _, err := inbox.Ack(ctx, d, t0, devtool, tc.session, item.ID, tc.token); err != nil || ok {
				t.Errorf("%s: ok=%v err=%v, want claim lost", name, ok, err)
			}
		}
		if ok, conv, err := inbox.Ack(ctx, d, t0, devtool, sessA, item.ID, item.ClaimToken); err != nil || !ok || conv != conv1 {
			t.Errorf("right token: ok=%v conv=%d err=%v", ok, conv, err)
		}
		if ok, _, _ := inbox.Ack(ctx, d, t0, devtool, sessA, item.ID, item.ClaimToken); ok {
			t.Error("a second ack is a lost claim")
		}
		if left, _ := inbox.Peek(ctx, d, t0, devtool, sessA); len(left) != 0 {
			t.Errorf("an acked item is gone from peek: %+v", left)
		}
	})
}

func TestAnAckAfterTheClaimRanOutIsLost(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	item := claim(t, s, t0, sessA, false)[0]
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if ok, _, _ := inbox.Ack(ctx, d, t0.Add(inbox.DefaultVisibility+time.Second), devtool, sessA, item.ID, item.ClaimToken); ok {
			t.Error("an expired claim cannot be acked")
		}
	})
}

func TestPeekShowsTheTokenOnlyToTheHoldingSession(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	fan(t, s, t0, conv2, 2)
	claim(t, s, t0, sessA, false)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		mine, _ := inbox.Peek(ctx, d, t0, devtool, sessA)
		other, _ := inbox.Peek(ctx, d, t0, devtool, sessB)
		if len(mine) != 2 || len(other) != 2 {
			t.Fatalf("both see both items: %d %d", len(mine), len(other))
		}
		for i := range mine {
			if mine[i].State != "claimed" || mine[i].ClaimToken == nil || mine[i].ClaimUntil == 0 {
				t.Errorf("the holder sees its token and the end: %+v", mine[i])
			}
			if other[i].State != "claimed" || other[i].ClaimToken != nil {
				t.Errorf("another session sees the state but never the token: %+v", other[i])
			}
		}
	})
}

func TestExtendMovesTheEndUpToTheLeaseAndReportsTheConversation(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	claim(t, s, t0, sessA, false)
	later := t0.Add(time.Minute)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		holds, err := inbox.Extend(ctx, d, later, sessA, leaseEnd)
		if want := later.Add(inbox.DefaultVisibility).UnixMilli(); err != nil || len(holds) != 1 || holds[0].Conversation != conv1 || holds[0].Until != want {
			t.Errorf("extended by one visibility from now: %+v err=%v, want until %d", holds, err, want)
		}
		holds, _ = inbox.Extend(ctx, d, later, sessA, later.UnixMilli()+1000)
		if len(holds) != 1 || holds[0].Until != later.UnixMilli()+1000 {
			t.Errorf("never past the end of the lease: %+v", holds)
		}
		if holds, _ := inbox.Extend(ctx, d, later, sessB, leaseEnd); len(holds) != 0 {
			t.Errorf("another session's renewal extends nothing: %+v", holds)
		}
	})
}

func TestReleaseFreesTheClaimsAtOnceForAnotherSession(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	claim(t, s, t0, sessA, false)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		convs, err := inbox.Release(ctx, d, t0.Add(time.Second), sessA)
		if err != nil || len(convs) != 1 || convs[0] != conv1 {
			t.Errorf("released the claim on conversation 10: %v %v", convs, err)
		}
	})
	if got := claim(t, s, t0.Add(2*time.Second), sessB, false); len(got) != 1 {
		t.Errorf("the other session takes it at once: %+v", got)
	}
}

func fanAs(t *testing.T, s *pdb.Store, at time.Time, conv, msg int64, reason string) {
	t.Helper()
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if err := inbox.FanOut(ctx, d, at, devtool, conv, msg, msg, 0, reason); err != nil {
			t.Fatal(err)
		}
	})
}

func TestAMentionRaisesTheReasonAndCountsItself(t *testing.T) {
	s := seeded(t)
	fanAs(t, s, t0, conv1, 1, inbox.ReasonActivity)
	fanAs(t, s, t0, conv1, 2, inbox.ReasonMention)
	fanAs(t, s, t0, conv1, 3, inbox.ReasonActivity) // a later plain message does not lower it
	got := claim(t, s, t0, sessA, false)
	if len(got) != 1 || got[0].Reason != inbox.ReasonMention || got[0].Count != 3 || got[0].MentionCount != 1 {
		t.Errorf("one mention item of 3 messages, 1 of them a mention: %+v", got)
	}
}

func TestAThreadReplyOutranksActivityButNotAMention(t *testing.T) {
	s := seeded(t)
	fanAs(t, s, t0, conv1, 1, inbox.ReasonActivity)
	fanAs(t, s, t0, conv1, 2, inbox.ReasonThread)
	fanAs(t, s, t0, conv1, 3, inbox.ReasonMention)
	fanAs(t, s, t0, conv1, 4, inbox.ReasonThread)
	if got := claim(t, s, t0, sessA, false); len(got) != 1 || got[0].Reason != inbox.ReasonMention || got[0].MentionCount != 1 {
		t.Errorf("mention over thread over activity: %+v", got)
	}
}

func TestAClaimCanBeLimitedToOneConversation(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	fan(t, s, t0, conv2, 2)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		got, err := inbox.Claim(ctx, d, t0, inbox.Request{Identity: devtool, Session: sessA, N: inbox.MaxClaim, IncludeHeld: true, Conv: conv2})
		if err != nil || len(got) != 1 || got[0].ConversationID != conv2 {
			t.Errorf("only conversation 11: %+v err=%v", got, err)
		}
	})
	if got := claim(t, s, t0, sessB, false); len(got) != 1 || got[0].ConversationID != conv1 {
		t.Errorf("conversation 10 is still ready for the other session: %+v", got)
	}
}

func TestReleaseMergesTheClaimIntoTheNewerReadyItem(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	claim(t, s, t0, sessA, false)
	fan(t, s, t0.Add(time.Second), conv1, 2)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if _, err := inbox.Release(ctx, d, t0.Add(2*time.Second), sessA); err != nil {
			t.Fatal(err)
		}
		peeked, err := inbox.Peek(ctx, d, t0.Add(3*time.Second), devtool, sessB)
		if err != nil || len(peeked) != 1 || peeked[0].Count != 2 || peeked[0].State != "ready" {
			t.Errorf("one ready item covering both messages: %+v err=%v", peeked, err)
		}
	})
}

func TestTransferKeepsTheTokenAndMovesTheClaimToTheNewSession(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	first := claim(t, s, t0, sessA, false)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if err := inbox.Transfer(ctx, d, t0.Add(time.Second), []int64{sessA}, sessB); err != nil {
			t.Fatal(err)
		}
	})
	got := claim(t, s, t0.Add(2*time.Second), sessB, true)
	if len(got) != 1 || !got[0].Held || !bytes.Equal(got[0].ClaimToken, first[0].ClaimToken) {
		t.Errorf("the new session holds the item under the same token: %+v", got)
	}
	if again := claim(t, s, t0.Add(2*time.Second), sessA, true); len(again) != 0 {
		t.Errorf("the old session holds nothing: %+v", again)
	}
}

func TestHoldsLiveClaimIsTrueOnlyWhileTheClaimLasts(t *testing.T) {
	s := seeded(t)
	fan(t, s, t0, conv1, 1)
	claim(t, s, t0, sessA, false)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		for _, c := range []struct {
			at   time.Time
			who  int64
			want bool
		}{{t0, sessA, true}, {t0, sessB, false}, {t0.Add(inbox.DefaultVisibility + time.Second), sessA, false}} {
			if got, err := inbox.HoldsLiveClaim(ctx, d, c.at, c.who); err != nil || got != c.want {
				t.Errorf("session %d at %v: %v (err %v), want %v", c.who, c.at, got, err, c.want)
			}
		}
	})
}
