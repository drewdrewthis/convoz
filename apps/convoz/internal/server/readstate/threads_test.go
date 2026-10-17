package readstate_test

import (
	"context"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// threadSeeded is seeded plus a root (id 20) in conversation 10, the thread rows hang off.
func threadSeeded(t *testing.T) *pdb.Store {
	s := seeded(t)
	dbtest.Exec(t, s, `INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (20,10,1,'text','root',1)`)
	return s
}

func positions(t *testing.T, s *pdb.Store) map[int64]int64 {
	t.Helper()
	out := map[int64]int64{}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		list, err := readstate.Threads(ctx, d, reader, conv)
		for _, p := range list {
			out[p.Root] = p.LastRead
		}
		return err
	})
	return out
}

func TestAThreadIsReadOnlyWhereTheReaderIsInvolved(t *testing.T) {
	s := threadSeeded(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if moved, err := readstate.ReadThread(ctx, d, reader, conv, 20, 25); err != nil || moved {
			t.Errorf("a thread the reader is not in has no position to move: moved=%v err=%v", moved, err)
		}
		if err := readstate.Involve(ctx, d, t0, reader, conv, 20, 22); err != nil {
			return err
		}
		if err := readstate.Involve(ctx, d, t0, reader, conv, 20, 99); err != nil { // being involved again keeps the first position
			return err
		}
		for _, tc := range []struct {
			to    int64
			moved bool
		}{{25, true}, {25, false}, {23, false}} {
			if moved, err := readstate.ReadThread(ctx, d, reader, conv, 20, tc.to); err != nil || moved != tc.moved {
				t.Errorf("ReadThread to %d: moved=%v err=%v, want moved=%v", tc.to, moved, err, tc.moved)
			}
		}
		return nil
	})
	if got := positions(t, s); len(got) != 1 || got[20] != 25 {
		t.Errorf("positions %v, want the one thread at 25", got)
	}
}

func TestAReplyMovesTheAuthorsThreadOnlyWhenCaughtUp(t *testing.T) {
	cases := []struct {
		name         string
		last, prev   int64
		want         int64
		replyID      int64
		behindReason string
	}{
		{"caught up", 30, 30, 31, 31, ""},
		{"behind: a reply is unread before it", 25, 30, 25, 31, "unread reply stays unread"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := threadSeeded(t)
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				if err := readstate.Involve(ctx, d, t0, reader, conv, 20, tc.last); err != nil {
					return err
				}
				return readstate.MoveThreadForOwnReply(ctx, d, reader, conv, 20, tc.prev, tc.replyID)
			})
			if got := positions(t, s)[20]; got != tc.want {
				t.Errorf("position %d, want %d (%s)", got, tc.want, tc.behindReason)
			}
		})
	}
}

func TestMarkAllReadMovesTheThreadFloorForwardOnly(t *testing.T) {
	s := threadSeeded(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := readstate.Create(ctx, d, t0, reader, conv, 10); err != nil {
			return err
		}
		for _, tc := range []struct {
			to    int64
			moved bool
		}{{50, true}, {50, false}, {40, false}} {
			if moved, err := readstate.MoveFloor(ctx, d, t0, reader, conv, tc.to); err != nil || moved != tc.moved {
				t.Errorf("MoveFloor to %d: moved=%v err=%v, want %v", tc.to, moved, err, tc.moved)
			}
		}
		if at, err := readstate.Floor(ctx, d, reader, conv); err != nil || at != 50 {
			t.Errorf("floor %d err=%v, want 50", at, err)
		}
		return nil
	})
}
