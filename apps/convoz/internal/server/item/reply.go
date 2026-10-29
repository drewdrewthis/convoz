package item

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// OwnerReplied is the owner's reply in the item's thread (owner, conv 179 msg 12444: "Send a reply closes the item"): the item is acked
// like an Okay, so the feed hides it. The state stays. A finished item is acked too; a dropped one is left alone.
func OwnerReplied(ctx context.Context, d pdb.DBTX, now time.Time, by, id int64) (Item, error) {
	it, err := ByID(ctx, d, id)
	if err != nil {
		return Item{}, err
	}
	if it.State == Dropped || it.AckedAt != 0 {
		return it, nil
	}
	it.AckedAt, it.AckedBy, it.AckKind = now.UnixMilli(), by, "got_it"
	return it, save(ctx, d, &it, now, false, "info", by, "reply")
}

// AgentReplied brings back every item rooted at the thread an agent wrote in: the ack and the snooze are cleared, snoozed or not ("when
// the agent replies it re opens"). The client reads acked_at and snoozed_until, so clearing both is all it needs. An item neither acked nor
// snoozed is left as it is.
func AgentReplied(ctx context.Context, d pdb.DBTX, now time.Time, conv, root int64) error {
	rows, err := db.New(d).ItemsByRoot(ctx, nint(root))
	if err != nil {
		return err
	}
	for _, r := range rows {
		it := fromRow(r)
		if it.Conversation != conv || (it.AckedAt == 0 && it.SnoozedUntil == 0) {
			continue
		}
		unack(&it)
		it.SnoozedUntil = 0
		if err := save(ctx, d, &it, now, true, "say", it.Agent, "reply"); err != nil {
			return err
		}
	}
	return nil
}
