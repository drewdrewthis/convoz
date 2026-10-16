package readstate_test

import (
	"context"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

const reader, conv = int64(1), int64(10)

var t0 = time.Unix(1_800_000_000, 0)

func seeded(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`)
	return s
}

func cursor(t *testing.T, s *pdb.Store) (at int64, found bool) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		at, found, err = readstate.Cursor(ctx, d, reader, conv)
		return err
	})
	return at, found
}

func TestACursorStartsAtTheNewestMessageAndAnExistingOneStays(t *testing.T) {
	s := seeded(t)
	if _, found := cursor(t, s); found {
		t.Fatal("no cursor before Create")
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := readstate.Create(ctx, d, t0, reader, conv, 40); err != nil {
			return err
		}
		return readstate.Create(ctx, d, t0, reader, conv, 99) // a second Create must not skip past unread messages
	})
	if at, found := cursor(t, s); !found || at != 40 {
		t.Errorf("history is not unread, and Create twice keeps the first: at=%d found=%v", at, found)
	}
}

func TestACursorOnlyMovesForward(t *testing.T) {
	s := seeded(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := readstate.Create(ctx, d, t0, reader, conv, 10); err != nil {
			return err
		}
		for _, tc := range []struct {
			to    int64
			moved bool
		}{{20, true}, {20, false}, {15, false}, {21, true}} {
			moved, err := readstate.Move(ctx, d, t0, reader, conv, tc.to)
			if err != nil || moved != tc.moved {
				t.Errorf("Move to %d: moved=%v err=%v, want moved=%v", tc.to, moved, err, tc.moved)
			}
		}
		return nil
	})
	if at, _ := cursor(t, s); at != 21 {
		t.Errorf("cursor ends at the highest move: %d", at)
	}
}

func TestAPostMovesTheAuthorsCursorOnlyWhenItWasCaughtUp(t *testing.T) {
	cases := []struct {
		name         string
		cursor, prev int64
		moved        bool
	}{
		{"caught up", 10, 10, true},
		{"behind: there is something unread before the post", 5, 10, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := seeded(t)
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				if err := readstate.Create(ctx, d, t0, reader, conv, tc.cursor); err != nil {
					return err
				}
				moved, err := readstate.MoveForOwnPost(ctx, d, t0, reader, conv, tc.prev, 11)
				if err != nil || moved != tc.moved {
					t.Errorf("moved=%v err=%v, want %v", moved, err, tc.moved)
				}
				return nil
			})
			want := tc.cursor
			if tc.moved {
				want = max(tc.cursor, 11)
			}
			if at, _ := cursor(t, s); at != want {
				t.Errorf("cursor %d, want %d", at, want)
			}
		})
	}
}
