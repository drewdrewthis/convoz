package item

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func finish(ctx context.Context, d pdb.DBTX, now time.Time, by int64, it Item, kind, event, note string) (Item, error) {
	it.AckedAt, it.AckedBy, it.AckKind = now.UnixMilli(), by, kind
	return leave2(ctx, d, now, it, event, by, note)
}

// leave2 is leave for the owner's moves: the audit names the owner.
func leave2(ctx context.Context, d pdb.DBTX, now time.Time, it Item, event string, by int64, note string) (Item, error) {
	it.State = Done
	if err := save(ctx, d, &it, now, true, event, by, note); err != nil {
		return Item{}, err
	}
	return it, promote(ctx, d, now, it.Agent, it.Plan)
}

// Accept does what the item recommends and ends it at once. ifVersion is the version the owner saw: any later edit by the agent makes it
// ErrVersion. An item with no recommendation cannot be accepted.
func Accept(ctx context.Context, d pdb.DBTX, now time.Time, by, id, ifVersion int64) (Item, error) {
	it, err := ByID(ctx, d, id)
	if err != nil {
		return Item{}, err
	}
	if it.State != Blocking {
		return Item{}, ErrConflict
	}
	if it.Version != ifVersion {
		return Item{}, ErrVersion
	}
	if it.Recommendation == "" {
		return Item{}, ErrNoRecommendation
	}
	return finish(ctx, d, now, by, it, "accept", "accept", "")
}

// Answer is the owner's info on a blocking item. With resolves it ends the item ("this answers it"); without, the item stays blocking.
func Answer(ctx context.Context, d pdb.DBTX, now time.Time, by, id int64, text string, resolves bool) (Item, error) {
	note, err := checkText(text, 1, MaxContext)
	if err != nil {
		return Item{}, err
	}
	it, err := ByID(ctx, d, id)
	if err != nil {
		return Item{}, err
	}
	if it.State != Blocking {
		return Item{}, ErrConflict
	}
	if resolves {
		return finish(ctx, d, now, by, it, "answer", "answer", note)
	}
	return it, db.New(d).InsertEvent(ctx, db.InsertEventParams{ItemID: it.ID, Version: it.Version, Event: "info", ToState: it.State, ByIdentity: nint(by), Note: note, At: now.UnixMilli()})
}

// GotIt is the owner's Okay on an item that has no move of its own: the state stays and the feed hides it. It works on a started, a blocking
// (with or without a recommendation), a pending and an fyi item. A later move of the agent (an edit, a block, done, fyi) clears it: see unack.
func GotIt(ctx context.Context, d pdb.DBTX, now time.Time, by, id int64) (Item, error) {
	it, err := ByID(ctx, d, id)
	if err != nil {
		return Item{}, err
	}
	if !snoozable(it) {
		return Item{}, ErrConflict
	}
	if it.AckedAt != 0 {
		return it, nil
	}
	it.AckedAt, it.AckedBy, it.AckKind = now.UnixMilli(), by, "got_it"
	if it.State == Blocking {
		// The Okay on a question's blocker clears the block, and the answer is still owed: the item is the agent's again (started).
		if q, err := IsQuestion(ctx, d, id); err != nil {
			return Item{}, err
		} else if q {
			it.State, it.OwnerStep = Started, false
		}
	}
	return it, save(ctx, d, &it, now, false, "got_it", by, "")
}

func snoozable(it Item) bool {
	return it.State == Pending || it.State == Started || it.State == Blocking || it.State == Fyi
}

// Snooze hides an item from the owner's feed until a time in the future.
func Snooze(ctx context.Context, d pdb.DBTX, now time.Time, by, id, until int64) (Item, error) {
	if until <= now.UnixMilli() {
		return Item{}, ErrText
	}
	return setSnooze(ctx, d, now, by, id, until, "snooze")
}

// Unsnooze brings a snoozed item back.
func Unsnooze(ctx context.Context, d pdb.DBTX, now time.Time, by, id int64) (Item, error) {
	return setSnooze(ctx, d, now, by, id, 0, "unsnooze")
}

func setSnooze(ctx context.Context, d pdb.DBTX, now time.Time, by, id, until int64, event string) (Item, error) {
	it, err := ByID(ctx, d, id)
	if err != nil {
		return Item{}, err
	}
	if !snoozable(it) {
		return Item{}, ErrConflict
	}
	it.SnoozedUntil = until
	return it, save(ctx, d, &it, now, false, event, by, "")
}
