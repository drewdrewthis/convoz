package item

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// create adds an item at the tail of the plan: now when the plan has no now, else pending.
func create(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key string, f Fields, owner bool) (Item, error) {
	q := db.New(d)
	if f.Plan == "" {
		f.Plan = "main"
	}
	state, ownerStep := Started, int64(0)
	if owner {
		state, ownerStep = Blocking, 1
	}
	if _, err := q.NowOf(ctx, db.NowOfParams{AgentID: agent, PlanKey: f.Plan}); err == nil {
		state = Pending
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Item{}, err
	}
	seq, err := q.NextSeq(ctx, agent)
	if err != nil {
		return Item{}, err
	}
	row, err := q.InsertItem(ctx, db.InsertItemParams{AgentID: agent, ConversationID: conv, PlanKey: f.Plan, WorkKey: key, Seq: seq, State: state, OwnerStep: ownerStep,
		Title: f.Title, Context: f.Context, Recommendation: nstr(f.Recommend), DueAt: nint(f.DueAt), Now: now.UnixMilli()})
	if err != nil {
		return Item{}, err
	}
	it := fromRow(row)
	if f.Root != 0 {
		if err := SetThreadRoot(ctx, d, it.ID, f.Root); err != nil {
			return Item{}, err
		}
		it.ThreadRoot = f.Root
	}
	event := "start"
	if owner {
		event = "block"
	}
	return it, db.New(d).InsertEvent(ctx, db.InsertEventParams{ItemID: it.ID, Version: 1, Event: event, ToState: it.State, ByIdentity: nint(agent), At: now.UnixMilli()})
}

func validKey(key string) bool { return len(key) >= 1 && len(key) <= 64 }

// Start says the agent works on a step. A key it already holds comes back as it is; a changed text bumps the version.
func Start(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key string, f Fields) (Item, error) {
	f, err := f.check()
	if err != nil || !validKey(key) {
		return Item{}, ErrText
	}
	it, err := ByKey(ctx, d, agent, conv, key)
	if errors.Is(err, ErrNotFound) {
		return create(ctx, d, now, agent, conv, key, f, false)
	}
	if err != nil {
		return Item{}, err
	}
	if it.State != Started && it.State != Pending || f.Plan != "" && it.Plan != f.Plan {
		return Item{}, ErrConflict
	}
	if it.Title == f.Title && it.Context == f.Context && it.DueAt == f.DueAt {
		return it, nil
	}
	it.Title, it.Context, it.DueAt = f.Title, f.Context, f.DueAt
	unack(&it)
	return it, save(ctx, d, &it, now, true, "edit", agent, "")
}

// Block says the next step is the owner's. Saying it again edits the item and bumps the version, so an Accept made on the old
// text fails. A recommendation is optional: without one the owner can only add info.
func Block(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key string, f Fields) (Item, error) {
	f, err := f.check()
	if err != nil || !validKey(key) {
		return Item{}, ErrText
	}
	it, err := ByKey(ctx, d, agent, conv, key)
	if errors.Is(err, ErrNotFound) {
		return create(ctx, d, now, agent, conv, key, f, true)
	}
	if err != nil {
		return Item{}, err
	}
	if it.State != Started && it.State != Blocking && it.State != Pending || f.Plan != "" && it.Plan != f.Plan {
		return Item{}, ErrConflict
	}
	it.Title, it.Context, it.DueAt, it.OwnerStep = f.Title, f.Context, f.DueAt, true
	it.Recommendation = f.Recommend
	if it.State == Started {
		it.State = Blocking
	}
	unack(&it)
	return it, save(ctx, d, &it, now, true, "block", agent, "")
}

// unack brings an item back to the owner's feed: whatever the agent does to an item the owner said Okay to, he sees it again.
func unack(it *Item) { it.AckedAt, it.AckedBy, it.AckKind = 0, 0, "" }

// leave moves an item that held a place in the plan to a final state and promotes the next one.
func leave(ctx context.Context, d pdb.DBTX, now time.Time, it Item, to, event, note string) (Item, error) {
	wasNow := it.State == Started || it.State == Blocking
	it.State = to
	unack(&it)
	if err := save(ctx, d, &it, now, true, event, it.Agent, note); err != nil {
		return Item{}, err
	}
	if wasNow {
		if err := promote(ctx, d, now, it.Agent, it.Plan); err != nil {
			return Item{}, err
		}
	}
	return it, nil
}

// MarkDone finishes a started step. Saying it twice changes nothing.
func MarkDone(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key, outcome string) (Item, error) {
	note, err := checkText(outcome, 0, MaxContext)
	if err != nil {
		return Item{}, err
	}
	it, err := ByKey(ctx, d, agent, conv, key)
	if err != nil || it.State == Done {
		return it, err
	}
	if it.State != Started {
		return Item{}, ErrConflict
	}
	return leave(ctx, d, now, it, Done, "done", note)
}

// MarkFyi says the agent got round a blocking step: it no longer needs the owner.
func MarkFyi(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key, what string) (Item, error) {
	note, err := checkText(what, 0, MaxContext)
	if err != nil {
		return Item{}, err
	}
	it, err := ByKey(ctx, d, agent, conv, key)
	if err != nil || it.State == Fyi {
		return it, err
	}
	if it.State != Blocking {
		return Item{}, ErrConflict
	}
	return leave(ctx, d, now, it, Fyi, "fyi", note)
}

// Drop gives up an open step.
func Drop(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key string) (Item, error) {
	it, err := ByKey(ctx, d, agent, conv, key)
	if err != nil || it.State == Dropped {
		return it, err
	}
	if it.State != Pending && it.State != Started && it.State != Blocking {
		return Item{}, ErrConflict
	}
	return leave(ctx, d, now, it, Dropped, "drop", "")
}

// Say leaves a note on the item; state and version stay.
func Say(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, key, text string) (Item, error) {
	note, err := checkText(text, 1, MaxContext)
	if err != nil {
		return Item{}, err
	}
	it, err := ByKey(ctx, d, agent, conv, key)
	if err != nil {
		return Item{}, err
	}
	return it, db.New(d).InsertEvent(ctx, db.InsertEventParams{ItemID: it.ID, Version: it.Version, Event: "say", ToState: it.State, ByIdentity: nint(agent), Note: note, At: now.UnixMilli()})
}
