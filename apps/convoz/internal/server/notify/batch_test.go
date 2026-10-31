package notify

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// Advisor before the PR 253 deploy: a busy hour was about 105 message pushes and up to 61 rings. A plain message push rings at most
// once per conversation in 5 minutes; the ones in between are recorded as batched, and the next push after the window says how many.

func TestABatchedMessageIsSuppressedButNothingElseIs(t *testing.T) {
	env := Env{Visible: true, Enabled: true, Batched: true}
	if d, why := Decide(Trigger{Reason: ReasonMessage}, env, 1); d != Suppressed || why != WhyBatched {
		t.Errorf("message: %s %s", d, why)
	}
	for _, r := range []string{ReasonMention, ReasonThreadReply, ReasonAsk, ReasonMachineRequest} {
		if d, why := Decide(Trigger{Reason: r}, env, 1); d != Send {
			t.Errorf("%s is never batched: %s %s", r, d, why)
		}
	}
}

// envOnly is a Source whose every trigger is visible and enabled; Record reads nothing else from it.
type envOnly struct{ Source }

func (envOnly) Env(context.Context, pdb.DBTX, Trigger, time.Time) (Env, error) {
	return Env{Visible: true, Enabled: true}, nil
}

func TestMessagePushesRingOncePerConversationIn5MinutesAndTheNextCountsTheBatch(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (41,1,1,1)`,
		`INSERT INTO devices (id, human_id, token_hash, label, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (7,1,zeroblob(32),'phone',1,1,9,9)`,
		`INSERT INTO push_subscriptions (id, device_id, identity_id, endpoint, p256dh, auth, messages, created_at) VALUES (3,7,1,'https://web.push.apple.com/x',zeroblob(65),zeroblob(16),1,1)`)
	keys, err := NewKeys([]byte("seed"), []byte("topic"))
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{Keys: keys, Source: envOnly{}}
	t0 := time.UnixMilli(1_000_000_000)
	steps := []struct {
		seq    int64
		reason string
		at     time.Duration
	}{
		{1, ReasonMessage, 0},
		{2, ReasonMessage, time.Minute},
		{3, ReasonMention, time.Minute},
		{4, ReasonMessage, 2 * time.Minute},
		{5, ReasonMessage, 6 * time.Minute}, // 6 minutes after the last push that rang
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		for _, st := range steps {
			tr := Trigger{Person: 1, Reason: st.reason, SourceSeq: st.seq, Conversation: 41, TopicKind: TopicConversation, TopicID: 41}
			if err := svc.Record(ctx, d, t0.Add(st.at), tr); err != nil {
				return err
			}
		}
		return nil
	})
	var got []string
	burst := map[int64]int64{}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		rows, err := d.QueryContext(ctx, `SELECT id, source_seq, reason, topic, decision, coalesce(suppressed_reason, ''), created_at FROM notifications ORDER BY source_seq`)
		if err != nil {
			return err
		}
		defer rows.Close()
		var sent []Notification
		for rows.Next() {
			var n Notification
			var decision, why string
			if err := rows.Scan(&n.ID, &n.SourceSeq, &n.Reason, &n.Topic, &decision, &why, &n.CreatedAt); err != nil {
				return err
			}
			n.Person, n.Conversation = 1, 41
			got = append(got, fmt.Sprintf("%d %s %s %s", n.SourceSeq, n.Reason, decision, why))
			if decision == Send {
				sent = append(sent, n)
			}
		}
		for _, n := range sent {
			b, err := burstOf(ctx, d, n)
			if err != nil {
				return err
			}
			burst[n.SourceSeq] = b
		}
		return rows.Err()
	})
	want := []string{"1 message send ", "2 message suppressed " + WhyBatched, "3 mention send ", "4 message suppressed " + WhyBatched, "5 message send "}
	if !slices.Equal(got, want) {
		t.Errorf("decisions\n got %q\nwant %q", got, want)
	}
	if burst[1] != 1 || burst[5] != 3 {
		t.Errorf("the first rings alone; the one after the window says 3 new (2, 4 and itself): %v", burst)
	}
}
