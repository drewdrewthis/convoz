package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

type itemMove = func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error)

// itemMove runs one move the way POST /items/:key/:event does for start and block (withThreadRoot) and returns the item.
func (r *wakeRig) itemMove(t *testing.T, key string, wrap bool, move itemMove) (item.Item, error) {
	t.Helper()
	p := authz.Principal{Authenticated: true, SessionID: 9001, IdentityID: wakeA, Role: "agent"}
	var wake []int64
	if wrap {
		move = r.s.withThreadRoot(&call{p: p}, r.conv, key, move, &wake)
	}
	var it item.Item
	var err error
	err = r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, e = move(ctx, tx.DBTX(), time.UnixMilli(5_000_000))
		return e
	})
	return it, err
}

// texts is the body of each text message of the conversation, oldest first, with its id.
func (r *wakeRig) texts(t *testing.T) map[int64]string {
	t.Helper()
	rows, err := r.s.Store.Reader.SQL().Query(`SELECT id, body FROM messages WHERE conversation_id = ? AND kind = 'text' ORDER BY id`, r.conv)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var body string
		if err := rows.Scan(&id, &body); err != nil {
			t.Fatal(err)
		}
		out[id] = body
	}
	return out
}

func TestAnItemsFirstStartOrBlockPostsOneMessageAndKeepsItAsTheThreadRoot(t *testing.T) {
	r := newWakeRig(t)
	before := len(r.texts(t))
	start := func(key, title string) itemMove {
		return func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Start(ctx, d, now, wakeA, r.conv, key, item.Fields{Title: title})
		}
	}
	block := func(key, title string) itemMove {
		return func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Block(ctx, d, now, wakeA, r.conv, key, item.Fields{Title: title, Recommend: "Go"})
		}
	}
	for name, first := range map[string]struct {
		key  string
		move itemMove
		said string
	}{
		"start": {"s", start("s", "Index the filters"), "Index the filters"},
		"block": {"b", block("b", "Merge the filters"), "Merge the filters"},
	} {
		it, err := r.itemMove(t, first.key, true, first.move)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if it.ThreadRoot == 0 || r.texts(t)[it.ThreadRoot] != first.said {
			t.Fatalf("%s: the root %d is not a message that says %q: %v", name, it.ThreadRoot, first.said, r.texts(t))
		}
		kept, _ := r.itemMove(t, first.key, false, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.ByKey(ctx, d, wakeA, r.conv, first.key)
		})
		if kept.ThreadRoot != it.ThreadRoot {
			t.Fatalf("%s: the root is kept in the row: %d, want %d", name, kept.ThreadRoot, it.ThreadRoot)
		}
	}
	if got := len(r.texts(t)) - before; got != 2 {
		t.Fatalf("one message per new item, got %d", got)
	}

	// A later move on the same item posts nothing, and the root stays.
	count := len(r.texts(t))
	again, err := r.itemMove(t, "b", true, block("b", "Merge the filters now"))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.texts(t)) != count {
		t.Fatalf("a repeat move posts nothing: messages %d -> %d", count, len(r.texts(t)))
	}
	row, _ := r.itemMove(t, "b", false, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.ByKey(ctx, d, wakeA, r.conv, "b")
	})
	if row.ThreadRoot == 0 || again.ThreadRoot != row.ThreadRoot {
		t.Fatalf("the stored root stays after a later move and the answer carries it: row %d, answer %d", row.ThreadRoot, again.ThreadRoot)
	}
}

// fyi, done, drop and say are not wrapped: they never make an item, so they never post. fyi on a key that does not exist is not found.
func TestFyiNeverMakesAnItemOrPostsAMessage(t *testing.T) {
	r := newWakeRig(t)
	count := len(r.texts(t))
	_, err := r.itemMove(t, "ghost", false, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.MarkFyi(ctx, d, now, wakeA, r.conv, "ghost", "got round it")
	})
	if !errors.Is(err, item.ErrNotFound) || len(r.texts(t)) != count {
		t.Fatalf("fyi on a new key: err %v, messages %d -> %d", err, count, len(r.texts(t)))
	}
}
