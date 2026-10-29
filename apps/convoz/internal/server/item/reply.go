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
	return it, ackReply(ctx, d, now, by, &it)
}

func ackReply(ctx context.Context, d pdb.DBTX, now time.Time, by int64, it *Item) error {
	if it.State == Dropped || it.AckedAt != 0 {
		return nil
	}
	it.AckedAt, it.AckedBy, it.AckKind = now.UnixMilli(), by, "got_it"
	return save(ctx, d, it, now, false, "info", by, "reply")
}

// OwnerRepliedIn closes every item of the message whose thread the owner wrote in (msg 12251, 12583: one reply, all items on the message).
func OwnerRepliedIn(ctx context.Context, d pdb.DBTX, now time.Time, by, conv, root int64) error {
	rows, err := db.New(d).ItemsByRoot(ctx, nint(root))
	if err != nil {
		return err
	}
	for _, r := range rows {
		it := fromRow(r)
		if it.Conversation != conv {
			continue
		}
		if err := ackReply(ctx, d, now, by, &it); err != nil {
			return err
		}
	}
	return nil
}

// AgentReplied brings back every item rooted at the thread an agent wrote in: the ack and the snooze are cleared, snoozed or not ("when
// the agent replies it re opens"). The client reads acked_at and snoozed_until, so clearing both is all it needs. An item neither acked nor
// snoozed is left as it is. It returns the owners of the items that were open before this reply (not done, not dropped, not acked),
// poster excluded: they are woken, as a taken message is not one they wrote in. An acked item wakes nobody, so two agents cannot loop.
func AgentReplied(ctx context.Context, d pdb.DBTX, now time.Time, conv, root, poster int64) ([]int64, error) {
	rows, err := db.New(d).ItemsByRoot(ctx, nint(root))
	if err != nil {
		return nil, err
	}
	var owners []int64
	for _, r := range rows {
		it := fromRow(r)
		if it.Conversation != conv || it.State == Dropped {
			continue
		}
		if it.Agent != poster && it.State != Done && it.AckedAt == 0 && !contains(owners, it.Agent) {
			owners = append(owners, it.Agent)
		}
		if it.AckedAt == 0 && it.SnoozedUntil == 0 {
			continue
		}
		unack(&it)
		it.SnoozedUntil = 0
		if err := save(ctx, d, &it, now, true, "say", it.Agent, "reply"); err != nil {
			return nil, err
		}
	}
	return owners, nil
}

func contains(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}
