package conversation_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

func TestPickupIsForOneAgentAndTheFenceCountsUpForEver(t *testing.T) {
	s := seeded(t)
	c := create(t, s, t0, conversation.New{By: owner})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if _, err := conversation.Pickup(ctx, d, t0, c.ID, devtool, 0); !errors.Is(err, conversation.ErrNotOpen) {
			t.Errorf("a conversation nobody opened cannot be picked up: %v", err)
		}
		if err := conversation.OpenPickup(ctx, d, t0, c.ID, owner); err != nil {
			return err
		}
		first, err := conversation.Pickup(ctx, d, t0, c.ID, devtool, 0)
		if err != nil || first.Fence != 1 {
			t.Fatalf("the first pickup holds fence 1: %+v %v", first, err)
		}
		var taken conversation.TakenError
		if _, err := conversation.Pickup(ctx, d, t0, c.ID, docs, 0); !errors.As(err, &taken) || taken.Agent != devtool {
			t.Errorf("the second pickup is told who has it: %v", err)
		}
		if freed, err := conversation.ReleaseOf(ctx, d, c.ID, devtool); err != nil || !freed {
			t.Fatalf("release: %v %v", freed, err)
		}
		next, err := conversation.Pickup(ctx, d, t0, c.ID, docs, 0)
		if err != nil || next.Fence != 2 {
			t.Errorf("the fence never resets: %+v %v", next, err)
		}
		if err := conversation.Renew(ctx, d, t0, c.ID, devtool, first.Fence); !errors.Is(err, conversation.ErrStaleFence) {
			t.Errorf("the old holder is stale: %v", err)
		}
		return conversation.Renew(ctx, d, t0, c.ID, docs, next.Fence)
	})
}

func TestTwentyAgentMessagesInARowPauseAndAPersonResumes(t *testing.T) {
	s := seeded(t)
	c := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		for i := 1; i <= 20; i++ {
			paused, err := conversation.AgentPosted(ctx, d, t0, c.ID)
			if err != nil || paused != (i == 20) {
				t.Fatalf("message %d: paused=%v err=%v", i, paused, err)
			}
		}
		if got, _, _ := conversation.Get(ctx, d, c.ID); !got.Paused() || got.AgentStreak != 20 {
			t.Errorf("the 20th pauses: %+v", got)
		}
		if resumed, err := conversation.HumanPosted(ctx, d, c.ID); err != nil || !resumed {
			t.Errorf("a person lifts the pause: %v %v", resumed, err)
		}
		if got, _, _ := conversation.Get(ctx, d, c.ID); got.Paused() || got.AgentStreak != 0 {
			t.Errorf("the streak is back to 0: %+v", got)
		}
		return nil
	})
}

func TestCleanEmptyKeepsAConversationThatGetsAMessageMeanwhile(t *testing.T) {
	s := seeded(t)
	idle := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	raced := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	titled := create(t, s, t0, conversation.New{By: owner, Title: "Chosen", Members: []int64{devtool}})
	starred := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		isStarred := func(id int64) (bool, error) {
			if id == raced.ID { // the send lands after the candidates were listed and before the delete
				_, err := conversation.RecordMainPost(ctx, d, t0.Add(25*time.Hour), id, 3, "wait")
				return false, err
			}
			return id == starred.ID, nil
		}
		gone, err := conversation.CleanEmpty(ctx, d, t0.Add(25*time.Hour), isStarred)
		if err != nil || gone != 1 {
			t.Fatalf("only the idle conversation goes: gone=%d err=%v", gone, err)
		}
		for _, c := range []conversation.Conversation{raced, titled, starred} {
			if _, found, _ := conversation.Get(ctx, d, c.ID); !found {
				t.Errorf("conversation %d must stay", c.ID)
			}
		}
		if _, found, _ := conversation.Get(ctx, d, idle.ID); found {
			t.Error("the idle conversation goes")
		}
		return nil
	})
}

func TestTheTrashKeepsThirtyDaysThenPurges(t *testing.T) {
	s := seeded(t)
	c := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if gone, err := conversation.Delete(ctx, d, t0, c.ID, owner); err != nil || !gone {
			t.Fatalf("delete: %v %v", gone, err)
		}
		if _, found, _ := conversation.Get(ctx, d, c.ID); found {
			t.Error("a deleted conversation is not listed")
		}
		if n, err := conversation.PurgeTrash(ctx, d, t0.Add(29*24*time.Hour)); err != nil || n != 0 {
			t.Errorf("29 days in, nothing is purged: %d %v", n, err)
		}
		if n, err := conversation.PurgeTrash(ctx, d, t0.Add(31*24*time.Hour)); err != nil || n != 1 {
			t.Errorf("31 days in, it is: %d %v", n, err)
		}
		return nil
	})
}
