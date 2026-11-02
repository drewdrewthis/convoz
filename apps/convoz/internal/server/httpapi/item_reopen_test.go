package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// The owner's reply closes the item (it is acked, so the feed hides it); an agent's reply in its thread brings it back, snoozed or not
// (owner, conv 179 msg 12444: "Send a reply closes the item, yes, when the agent replies it re opens").

func TestTheOwnersReplyAcksTheItemAndTheStateStays(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	got, _, err := r.reply(t, it.ID, "Go, but wait for CI")
	if err != nil {
		t.Fatal(err)
	}
	row := r.itemRow(t, it.ID)
	if got.AckedAt == 0 || row.AckedAt == 0 || row.AckKind != "got_it" || row.State != item.Blocking {
		t.Fatalf("a reply acks and leaves the state: %+v", row)
	}
	// A second reply changes nothing about the ack.
	at := row.AckedAt
	if _, _, err := r.reply(t, it.ID, "Any news?"); err != nil || r.itemRow(t, it.ID).AckedAt != at {
		t.Fatalf("second reply: %v", err)
	}
}

func TestAnAgentsReplyInTheThreadReopensTheItem(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	first, _, _ := r.reply(t, it.ID, "Go")
	r.post(t, wakeA, 9001, first.ThreadRoot, "Done, CI is green")
	row := r.itemRow(t, it.ID)
	if row.AckedAt != 0 || row.AckKind != "" || row.Version <= first.Version {
		t.Fatalf("the agent's reply clears the ack and bumps the version: %+v", row)
	}
	// A reply of the owner alone does not reopen; his second reply acks again.
	if _, _, err := r.reply(t, it.ID, "Thanks"); err != nil || r.itemRow(t, it.ID).AckedAt == 0 {
		t.Fatalf("owner reply acks again: %v", err)
	}
}

func TestAnAgentsReplyReopensASnoozedItemAndClearsTheSnooze(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	first, _, _ := r.reply(t, it.ID, "Go")
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		_, err := item.Snooze(ctx, tx.DBTX(), time.Now(), r.ownerID(), it.ID, time.Now().Add(48*time.Hour).UnixMilli())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if r.itemRow(t, it.ID).SnoozedUntil == 0 {
		t.Fatal("snoozed")
	}
	r.post(t, wakeB, 9002, first.ThreadRoot, "Another agent, same thread")
	row := r.itemRow(t, it.ID)
	if row.SnoozedUntil != 0 || row.AckedAt != 0 {
		t.Fatalf("a reply in the thread clears the snooze and the ack: %+v", row)
	}
}

func TestAReplyInAnotherThreadOrByTheOwnerLeavesTheItemAlone(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	first, _, _ := r.reply(t, it.ID, "Go")
	other, _ := r.post(t, wakeA, 9001, 0, "Unrelated root")
	r.post(t, wakeA, 9001, other, "A reply elsewhere")
	if r.itemRow(t, it.ID).AckedAt == 0 {
		t.Fatal("a reply in another thread must not reopen it")
	}
	r.post(t, r.ownerID(), wakeOwnerSession, first.ThreadRoot, "Me again")
	if r.itemRow(t, it.ID).AckedAt == 0 {
		t.Fatal("the owner's own message in the thread must not reopen it")
	}
}
