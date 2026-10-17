package identity_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

func TestValidStatus(t *testing.T) {
	cases := []struct {
		state, doing, next, field string
	}{
		{"working", "Fixing #412", "Open PR", ""},
		{"idle", "", "", ""},
		{"napping", "", "", "state"},
		{"idle", strings.Repeat("é", 201), "", "doing"},
		{"idle", "", strings.Repeat("x", 201), "next"},
	}
	for _, c := range cases {
		if field, ok := identity.ValidStatus(c.state, c.doing, c.next); ok != (c.field == "") || field != c.field {
			t.Errorf("%+v: got %q %v", c, field, ok)
		}
	}
}

func TestStatusSinceMovesOnlyWhenTheStateChanges(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`, `INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`)
	t0 := time.UnixMilli(1_800_000_000_000)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if st, found, _ := identity.StatusOf(ctx, d, 2); found || st.State != "idle" || st.Since != 0 {
			t.Errorf("never reported reads as idle: %+v %v", st, found)
		}
		first, err := identity.SetStatus(ctx, d, t0, 2, "working", "a", "b")
		if err != nil {
			return err
		}
		again, err := identity.SetStatus(ctx, d, t0.Add(time.Minute), 2, "working", "c", "")
		if err != nil {
			return err
		}
		if again.Since != first.Since || again.UpdatedAt != t0.Add(time.Minute).UnixMilli() || again.Doing != "c" || again.Next != "" {
			t.Errorf("same state keeps since: %+v then %+v", first, again)
		}
		moved, err := identity.SetStatus(ctx, d, t0.Add(2*time.Minute), 2, "waiting", "", "")
		if err != nil || moved.Since != t0.Add(2*time.Minute).UnixMilli() {
			t.Errorf("a new state moves since: %+v %v", moved, err)
		}
		return nil
	})
}
