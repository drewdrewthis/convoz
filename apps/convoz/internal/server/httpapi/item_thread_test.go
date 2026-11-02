package httpapi

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// A feed item has no thread until someone writes in it: moves post no message; the owner's first write makes the root.

func (r *wakeRig) newItem(t *testing.T, key string) item.Item {
	t.Helper()
	var it item.Item
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, e = item.Block(ctx, tx.DBTX(), time.UnixMilli(5_000_000), wakeA, r.conv, key, item.Fields{Title: "Merge the filters", Recommend: "Go"})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	return it
}

func (r *wakeRig) reply(t *testing.T, id int64, text string) (item.Item, []int64, error) {
	t.Helper()
	var it item.Item
	var wake []int64
	c := &call{p: r.c.p, dev: r.c.dev, human: r.c.human}
	err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, wake, e = r.s.replyOnItem(ctx, tx.DBTX(), c, time.Now(), id, text)
		return e
	})
	return it, wake, err
}

func (r *wakeRig) itemRow(t *testing.T, id int64) item.Item {
	t.Helper()
	var it item.Item
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, e = item.ByID(ctx, tx.DBTX(), id)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	return it
}

func (r *wakeRig) bodies(t *testing.T) (all []string, roots map[int64]string, replies map[int64][]string) {
	t.Helper()
	rows, err := r.s.Store.Reader.SQL().Query(`SELECT id, COALESCE(thread_root_id, 0), body FROM messages WHERE conversation_id = ? AND kind = 'text' ORDER BY id`, r.conv)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	roots, replies = map[int64]string{}, map[int64][]string{}
	for rows.Next() {
		var id, root int64
		var body string
		if err := rows.Scan(&id, &root, &body); err != nil {
			t.Fatal(err)
		}
		all = append(all, body)
		if root == 0 {
			roots[id] = body
		} else {
			replies[root] = append(replies[root], body)
		}
	}
	return
}

func TestCreatingAnItemPostsNoMessageAndHasNoRoot(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	all, _, _ := r.bodies(t)
	if len(all) != 0 || it.ThreadRoot != 0 {
		t.Fatalf("a new item has no thread: messages %v, root %d", all, it.ThreadRoot)
	}
}

func TestTheFirstReplyMakesTheRootWithTheTitleQuotedAndLaterRepliesGoInTheThread(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	first, wake, err := r.reply(t, it.ID, "Go, but wait for CI")
	if err != nil || first.ThreadRoot == 0 {
		t.Fatalf("first reply: %v root %d", err, first.ThreadRoot)
	}
	_, roots, _ := r.bodies(t)
	if roots[first.ThreadRoot] != "> Merge the filters\n\nGo, but wait for CI" {
		t.Fatalf("the root quotes the title above the text: %q", roots[first.ThreadRoot])
	}
	if len(wake) == 0 || wake[0] != wakeA {
		t.Fatalf("the item's agent is woken by the owner's text, got %v", wake)
	}
	second, _, err := r.reply(t, it.ID, "Any news?")
	if err != nil || second.ThreadRoot != first.ThreadRoot {
		t.Fatalf("second reply: %v root %d want %d", err, second.ThreadRoot, first.ThreadRoot)
	}
	_, roots, replies := r.bodies(t)
	if len(roots) != 1 || len(replies[first.ThreadRoot]) != 1 || replies[first.ThreadRoot][0] != "Any news?" {
		t.Fatalf("the second text is a reply in the thread: roots %v replies %v", roots, replies)
	}
}

// Two owner writes at the same moment end with one root and one reply: the writer lock serializes them, the loser reads the winner's root first.
func TestTwoFirstRepliesAtOnceEndWithOneRoot(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, errs[i] = r.reply(t, it.ID, []string{"one", "two"}[i])
		}()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	_, roots, replies := r.bodies(t)
	root := r.itemRow(t, it.ID).ThreadRoot
	if len(roots) != 1 || roots[root] == "" || len(replies[root]) != 1 {
		t.Fatalf("one root and one reply: roots %v replies %v", roots, replies)
	}
	if !strings.HasPrefix(roots[root], "> Merge the filters") {
		t.Fatalf("the root quotes the title: %q", roots[root])
	}
}

// The only-if-NULL update keeps the first root even when a second is offered after it.
func TestTheGuardRefusesAForeignRoot(t *testing.T) {
	r := newWakeRig(t)
	it := r.newItem(t, "b")
	first, _, _ := r.reply(t, it.ID, "x")
	if err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		return item.SetThreadRoot(ctx, tx.DBTX(), it.ID, first.ThreadRoot+99)
	}); err != nil {
		t.Fatal(err)
	}
	if got := r.itemRow(t, it.ID).ThreadRoot; got != first.ThreadRoot {
		t.Fatalf("root changed to %d", got)
	}
}
