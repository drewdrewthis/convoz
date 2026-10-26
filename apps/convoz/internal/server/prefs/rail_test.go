package prefs_test

import (
	"context"
	"slices"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
)

var t0 = time.UnixMilli(1_800_000_000_000)

func ids(rows []prefs.Row) []int64 {
	out := make([]int64, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	return out
}

// apply stores the moved rows into the section the way the handler does, then returns the section in rail order.
func apply(section []prefs.Row, moved []prefs.Row) []prefs.Row {
	out := slices.Clone(section)
	for _, m := range moved {
		if i := slices.IndexFunc(out, func(r prefs.Row) bool { return r.ID == m.ID }); i >= 0 {
			out[i].Rank = m.Rank
		} else {
			out = append(out, m)
		}
	}
	prefs.Order(out)
	return out
}

func TestRail_NoPrefsRowNeeded(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		all, err := prefs.All(ctx, d, 1)
		if err != nil || len(all) != 0 {
			t.Fatalf("a person who touched nothing has no rows: %v %v", all, err)
		}
		if got := all[41].RankOf(1234); got != 1234 {
			t.Errorf("an untouched conversation ranks by last_activity_at, got %v", got)
		}
		return nil
	})
}

func TestRail_ActivityDoesNotReorderAndNewGoesTop(t *testing.T) {
	// The fallback rank is last_activity_at, so the freshest activity is first; a stored rank is cleared by FollowActivity (I-21).
	section := []prefs.Row{{ID: 41, Rank: 100}, {ID: 52, Rank: 200}, {ID: 60, Rank: 300}}
	prefs.Order(section)
	if got := ids(section); !slices.Equal(got, []int64{60, 52, 41}) {
		t.Fatalf("newest created first: %v", got)
	}
}

func TestRail_DragBetweenNeighbours(t *testing.T) {
	section := []prefs.Row{{ID: 60, Rank: 300}, {ID: 52, Rank: 200}, {ID: 41, Rank: 100}}
	cases := []struct {
		name  string
		id    int64
		after *int64
		want  []int64
	}{
		{"first", 41, nil, []int64{41, 60, 52}},
		{"between", 41, new(int64(60)), []int64{60, 41, 52}},
		{"last", 60, new(int64(41)), []int64{52, 41, 60}},
		{"stays", 52, new(int64(60)), []int64{60, 52, 41}},
	}
	for _, c := range cases {
		moved, err := prefs.Place(section, c.id, c.after, t0)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := ids(apply(section, moved)); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if _, err := prefs.Place(section, 41, new(int64(999)), t0); err != prefs.ErrNotInSection {
		t.Errorf("a neighbour outside the section is refused: %v", err)
	}
}

func TestRail_RenormalizeOnExhaustion(t *testing.T) {
	section := []prefs.Row{{ID: 3, Rank: 300}, {ID: 2, Rank: 200}, {ID: 1, Rank: 100}}
	want := []int64{3, 2, 1}
	// Dragging row 1 between 3 and 2, then 2 between 3 and 1, and so on halves the same gap until no midpoint fits.
	mover, other := int64(1), int64(2)
	for i := range 120 {
		moved, err := prefs.Place(section, mover, new(int64(3)), t0)
		if err != nil {
			t.Fatal(err)
		}
		section = apply(section, moved)
		want = []int64{3, mover, other}
		if got := ids(section); !slices.Equal(got, want) {
			t.Fatalf("drag %d: %v, want %v", i, got, want)
		}
		mover, other = other, mover
	}
	seen := map[float64]bool{}
	for _, r := range section {
		if seen[r.Rank] {
			t.Fatalf("two rows share rank %v", r.Rank)
		}
		seen[r.Rank] = true
	}
}

func TestRail_StoredPrefsRoundTrip(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, title_source, created_by, created_at, last_activity_at) VALUES (7,'auto',1,10,10)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (5,7,2,'text','hi',11)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := prefs.SetStarred(ctx, d, t0, 1, 7, true, 555); err != nil {
			return err
		}
		if err := prefs.SetMuted(ctx, d, t0, 1, 7, prefs.Forever); err != nil {
			return err
		}
		all, err := prefs.All(ctx, d, 1)
		if err != nil {
			return err
		}
		p := all[7]
		if !p.Starred || p.RankOf(10) != 555 || p.MutedUntil != prefs.Forever {
			t.Errorf("stored prefs %+v", p)
		}
		if err := prefs.SetMuted(ctx, d, t0, 1, 7, 0); err != nil {
			return err
		}
		if all, _ = prefs.All(ctx, d, 1); all[7].MutedUntil != 0 || !all[7].Starred {
			t.Errorf("unmute keeps the star: %+v", all[7])
		}
		// Pins: twice is once, and they are the person's own.
		for i, want := range []bool{true, false} {
			if changed, err := prefs.Pin(ctx, d, t0, 1, 5); err != nil || changed != want {
				t.Fatalf("pin #%d: changed %v err %v", i, changed, err)
			}
		}
		if got, _ := prefs.PinnedIDs(ctx, d, 1); !slices.Equal(got, []int64{5}) {
			t.Errorf("pins %v", got)
		}
		if got, _ := prefs.PinnedIDs(ctx, d, 2); len(got) != 0 {
			t.Errorf("another person's pins %v", got)
		}
		for i, want := range []bool{true, false} {
			if changed, err := prefs.Unpin(ctx, d, 1, 5); err != nil || changed != want {
				t.Fatalf("unpin #%d: changed %v err %v", i, changed, err)
			}
		}
		return nil
	})
}

func TestRail_FollowActivityClearsOnlyUnstarredRanks(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1), (11,1,1,1)`,
		`INSERT INTO conversation_prefs (identity_id, conversation_id, starred_at, rail_rank, updated_at) VALUES (1,10,NULL,5,1), (1,11,NULL,6,1)`)
	dbtest.Exec(t, s, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (2,'human','sam','Sam','sam','S',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (2,'member','bootstrap')`,
		`INSERT INTO conversation_prefs (identity_id, conversation_id, starred_at, rail_rank, updated_at) VALUES (2,10,1,7,1)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := prefs.FollowActivity(ctx, d, 10); err != nil {
			return err
		}
		one, _ := prefs.All(ctx, d, 1)
		two, _ := prefs.All(ctx, d, 2)
		if one[10].Rank != nil {
			t.Errorf("an unstarred rank is cleared, got %v", *one[10].Rank)
		}
		if one[11].Rank == nil {
			t.Error("another conversation keeps its rank")
		}
		if two[10].Rank == nil {
			t.Error("a starred row keeps its rank")
		}
		return nil
	})
}
