package conversation_test

import (
	"context"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

func shares(t *testing.T, s *pdb.Store, a, b int64) (got bool) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = conversation.Shares(ctx, d, a, b)
		return err
	})
	return got
}

func TestTwoAgentsShareWhenBothAreActiveInOneLiveConversation(t *testing.T) {
	s := seeded(t)
	if shares(t, s, devtool, docs) {
		t.Error("no conversation yet: nothing shared")
	}
	c := create(t, s, t0, conversation.New{By: devtool, Members: []int64{owner}, Pending: []int64{docs}})
	if shares(t, s, devtool, docs) {
		t.Error("a pending seat is not a seat: docs sees nothing there")
	}
	dbtest.Exec(t, s, `UPDATE participants SET status='active' WHERE identity_id=3`)
	if !shares(t, s, devtool, docs) || !shares(t, s, docs, devtool) {
		t.Error("both active in conversation: shared, in both directions")
	}
	dbtest.Exec(t, s, `UPDATE participants SET status='left' WHERE identity_id=3`)
	if shares(t, s, devtool, docs) {
		t.Error("a member who left no longer shares it")
	}
	dbtest.Exec(t, s, `UPDATE participants SET status='active' WHERE identity_id=3`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := conversation.Delete(ctx, d, t0, c.ID, owner)
		return err
	})
	if shares(t, s, devtool, docs) {
		t.Error("a conversation in the trash shares nothing")
	}
}
