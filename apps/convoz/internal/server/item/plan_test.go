package item_test

import (
	"context"
	"errors"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// A plan belongs to an agent: (agent, plan key), across conversations (conv 179 msg 12583, 12591).

func startIn(t *testing.T, s *pdb.Store, n int, agent, conv int64, key, plan string) item.Item {
	t.Helper()
	var it item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		it, err = item.Start(ctx, d, at(n), agent, conv, key, item.Fields{Title: "Step " + key, Context: "Because", Plan: plan})
		return err
	})
	return it
}

func TestAPlanSpansConversationsAndHasOneNow(t *testing.T) {
	s := rig(t)
	x := startIn(t, s, 1, devtool, convA, "x", "a")
	z := startIn(t, s, 2, devtool, convB, "z", "a")
	y := startIn(t, s, 3, devtool, convA, "y", "b")
	if x.State != item.Started || z.State != item.Pending || y.State != item.Started {
		t.Fatalf("states x %s z %s y %s", x.State, z.State, y.State)
	}
	if x.Plan != "a" || z.Plan != "a" || y.Plan != "b" || x.Seq != 1 || z.Seq != 2 || y.Seq != 3 {
		t.Fatalf("plans/seq: %+v %+v %+v", x, z, y)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkDone(ctx, d, at(4), devtool, convA, "x", "")
		return err
	})
	if got := get(t, s, devtool, convB, "z"); got.State != item.Started {
		t.Fatalf("done x promotes z, got %s", got.State)
	}
	if got := get(t, s, devtool, convA, "y"); got.State != item.Started || got.Version != 1 {
		t.Fatalf("plan b untouched: %+v", got)
	}
}

func TestNoPlanIsMainAndPlansOfAgentsAreApart(t *testing.T) {
	s := rig(t)
	a := startIn(t, s, 1, devtool, convA, "k", "")
	b := startIn(t, s, 2, docs, convA, "k", "")
	if a.Plan != "main" || b.Plan != "main" || b.State != item.Started || b.Seq != 1 {
		t.Fatalf("%+v %+v", a, b)
	}
}

func TestAKeyStaysInItsPlanAndIsUniquePerConversation(t *testing.T) {
	s := rig(t)
	startIn(t, s, 1, devtool, convA, "k", "a")
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Start(ctx, d, at(2), devtool, convA, "k", item.Fields{Title: "Step k", Context: "Because", Plan: "b"})
		return err
	})
	if !errors.Is(err, item.ErrConflict) {
		t.Fatalf("same key, other plan: %v", err)
	}
	if got := startIn(t, s, 3, devtool, convB, "k", "b"); got.State != item.Started || got.Plan != "b" {
		t.Fatalf("same key in another conversation: %+v", got)
	}
}

func TestAPlanKeyIsPlainAndShort(t *testing.T) {
	s := rig(t)
	for _, plan := range []string{"has space", "**bold**", string(make([]byte, 65))} {
		err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, err := item.Start(ctx, d, at(1), devtool, convA, "k", item.Fields{Title: "T", Context: "C", Plan: plan})
			return err
		})
		if !errors.Is(err, item.ErrText) {
			t.Errorf("plan %q: %v", plan, err)
		}
	}
}

func TestTheFeedListsEveryAgentAndPlanTogether(t *testing.T) {
	s := rig(t)
	startIn(t, s, 1, devtool, convA, "x", "a")
	startIn(t, s, 2, docs, convB, "y", "b")
	startIn(t, s, 3, devtool, convA, "m", "")
	var f item.Feed
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) { f, err = item.List(ctx, d, 5); return err })
	plans := map[string]bool{}
	for _, it := range f.Open {
		plans[it.Plan] = true
	}
	if len(f.Open) != 3 || !plans["a"] || !plans["b"] || !plans["main"] {
		t.Fatalf("%+v", f.Open)
	}
}

// An item made before plans is in c<conversation>. Start and block with no plan edit it; a named plan that differs is a conflict (0050).
func TestAnItemOfTheOldPlanTakesEditsThatNameNoPlan(t *testing.T) {
	s := rig(t)
	startIn(t, s, 1, devtool, convA, "old", "c41")
	if got := startIn(t, s, 2, devtool, convA, "old", ""); got.Plan != "c41" || got.State != item.Started {
		t.Fatalf("start with no plan: %+v", got)
	}
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Start(ctx, d, at(3), devtool, convA, "old", item.Fields{Title: "Step old", Context: "Because", Plan: "main"})
		return err
	})
	if !errors.Is(err, item.ErrConflict) {
		t.Fatalf("a named plan that differs: %v", err)
	}
}
