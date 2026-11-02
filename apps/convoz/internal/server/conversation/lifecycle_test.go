package conversation_test

import (
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

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

func TestCleanEmptyCountsOnlyAPersonsRename(t *testing.T) {
	s := seeded(t)
	byAgent := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	byPerson := create(t, s, t0, conversation.New{By: owner, Members: []int64{devtool}})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := conversation.Rename(ctx, d, byAgent.ID, "Agent title", conversation.TitleAgent); err != nil {
			return err
		}
		if err := conversation.Rename(ctx, d, byPerson.ID, "Person title", conversation.TitleHuman); err != nil {
			return err
		}
		never := func(int64) (bool, error) { return false, nil }
		if gone, err := conversation.CleanEmpty(ctx, d, t0.Add(25*time.Hour), never); err != nil || gone != 1 {
			t.Fatalf("only the agent-titled conversation goes: gone=%d err=%v", gone, err)
		}
		if _, found, _ := conversation.Get(ctx, d, byPerson.ID); !found {
			t.Error("a title a person chose keeps the conversation")
		}
		return nil
	})
}
