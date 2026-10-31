package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Owner (Drew, conv 179 msg 12993): "why wouldn't we just ping the agent via the inbox?" An item the agent started and left quiet for
// 15 minutes is a reminder in its inbox, once per quiet spell.

func (r *freshRig) itemDo(t *testing.T, fn func(ctx context.Context, d pdb.DBTX, now time.Time) error) {
	t.Helper()
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error { return fn(ctx, d, r.clock.Now()) })
}

func (r *freshRig) startItem(t *testing.T, key string) {
	r.itemDo(t, func(ctx context.Context, d pdb.DBTX, now time.Time) error {
		_, err := item.Start(ctx, d, now, 901, r.conv, key, item.Fields{Title: "Step " + key})
		return err
	})
}

func (r *freshRig) say(t *testing.T, key string) {
	r.itemDo(t, func(ctx context.Context, d pdb.DBTX, now time.Time) error {
		_, err := item.Say(ctx, d, now, 901, r.conv, key, "still going")
		return err
	})
}

// staleReminders counts every item_stale inbox item of the agent, whatever its state.
func (r *freshRig) staleReminders(t *testing.T) (n int) {
	t.Helper()
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT count(*) FROM inbox_items WHERE identity_id = 901 AND reason = 'item_stale'`).Scan(&n)
	})
	return n
}

func TestAStartedItemQuietForFifteenMinutesGetsOneReminder(t *testing.T) {
	r := newFreshRig(t)
	r.startItem(t, "a")
	r.clock.add(14 * time.Minute)
	r.sweep(t)
	if n := r.staleReminders(t); n != 0 {
		t.Fatalf("at 14 min: %d reminders", n)
	}
	r.clock.add(time.Minute)
	r.sweep(t)
	if n := r.staleReminders(t); n != 1 {
		t.Fatalf("at 15 min: %d reminders", n)
	}
}

func TestASecondSweepSendsNoSecondReminder(t *testing.T) {
	r := newFreshRig(t)
	r.startItem(t, "a")
	r.clock.add(20 * time.Minute)
	r.sweep(t)
	r.clock.add(20 * time.Minute)
	r.sweep(t)
	if n := r.staleReminders(t); n != 1 {
		t.Fatalf("%d reminders", n)
	}
}

func TestAfterASayAnotherQuietFifteenMinutesRemindsAgain(t *testing.T) {
	r := newFreshRig(t)
	r.startItem(t, "a")
	r.clock.add(15 * time.Minute)
	r.sweep(t)
	r.say(t, "a")
	r.clock.add(14 * time.Minute)
	r.sweep(t)
	if n := r.staleReminders(t); n != 1 {
		t.Fatalf("14 min after the say: %d reminders", n)
	}
	r.clock.add(time.Minute)
	r.sweep(t)
	if n := r.staleReminders(t); n != 2 {
		t.Fatalf("15 min after the say: %d reminders", n)
	}
}

func TestPendingAndBlockingItemsAreNeverReminded(t *testing.T) {
	r := newFreshRig(t)
	r.itemDo(t, func(ctx context.Context, d pdb.DBTX, now time.Time) error {
		if _, err := item.Block(ctx, d, now, 901, r.conv, "ask", item.Fields{Title: "Decide the open question", Recommend: "yes"}); err != nil {
			return err
		}
		_, err := item.Start(ctx, d, now, 901, r.conv, "later", item.Fields{Title: "Later"}) // waits behind the blocking now
		return err
	})
	r.clock.add(time.Hour)
	r.sweep(t)
	if n := r.staleReminders(t); n != 0 {
		t.Fatalf("blocking and pending: %d reminders", n)
	}
}

func TestADoneItemIsNeverReminded(t *testing.T) {
	r := newFreshRig(t)
	r.startItem(t, "a")
	r.itemDo(t, func(ctx context.Context, d pdb.DBTX, now time.Time) error {
		_, err := item.MarkDone(ctx, d, now, 901, r.conv, "a", "ok")
		return err
	})
	r.clock.add(time.Hour)
	r.sweep(t)
	if n := r.staleReminders(t); n != 0 {
		t.Fatalf("done: %d reminders", n)
	}
}

func TestTheReminderNamesTheItemAndHowToMoveIt(t *testing.T) {
	it := item.Item{Conversation: 41, Key: "build", Title: "Build invites", UpdatedAt: time.Date(2026, 10, 29, 9, 5, 0, 0, time.UTC).UnixMilli()}
	want := `Your item "Build invites" (41 build) has had no update since 09:05Z: say, done, block or drop it. convoz item say 41 build "..."`
	if got := itemStaleBody(it); got != want {
		t.Fatalf("body %q", got)
	}
}
