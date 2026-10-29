package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// An item is a message with state (conv 179 msg 12363, 12444): making one posts the agent's message and roots the item on it, in one transaction.

func (r *wakeRig) agentCall() *call {
	return &call{p: authz.Principal{Authenticated: true, SessionID: 9001, IdentityID: wakeA, Role: "agent"}, dev: r.c.dev, human: r.c.human}
}

func (r *wakeRig) move(t *testing.T, event, key string, f item.Fields, app []byte) (item.Item, error) {
	t.Helper()
	var it item.Item
	err := r.s.Store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		it, _, e = r.s.itemWithMessage(ctx, tx.DBTX(), r.agentCall(), time.Now(), r.conv, key, event, f, app)
		return e
	})
	return it, err
}

func (r *wakeRig) messageRow(t *testing.T, id int64) (author int64, body, app string, count int) {
	t.Helper()
	row := r.s.Store.Reader.SQL().QueryRow(`SELECT author_id, body, COALESCE(app_json, '') FROM messages WHERE id = ?`, id)
	if err := row.Scan(&author, &body, &app); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Store.Reader.SQL().QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, r.conv).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return
}

func TestStartingAnItemPostsTheAgentsMessageAndRootsTheItemOnIt(t *testing.T) {
	r := newWakeRig(t)
	it, err := r.move(t, "start", "a", item.Fields{Title: "Index the filters", Context: "The search is slow"}, nil)
	if err != nil || it.ThreadRoot == 0 {
		t.Fatalf("start: %v root %d", err, it.ThreadRoot)
	}
	author, body, _, count := r.messageRow(t, it.ThreadRoot)
	if author != wakeA || body != "Index the filters\n\nThe search is slow" || count != 1 {
		t.Fatalf("one message by the agent: author %d body %q count %d", author, body, count)
	}
	// Saying it again edits the item and posts nothing.
	again, err := r.move(t, "start", "a", item.Fields{Title: "Index the filters", Context: "Slow on 1M rows"}, nil)
	if _, _, _, n := r.messageRow(t, it.ThreadRoot); err != nil || n != 1 || again.ThreadRoot != it.ThreadRoot {
		t.Fatalf("an edit posts no message: %v count %d", err, n)
	}
}

func TestABlockerCarriesItsRecommendationInTheMessage(t *testing.T) {
	r := newWakeRig(t)
	it, err := r.move(t, "block", "b", item.Fields{Title: "Merge?", Context: "CI is green", Recommend: "Merge"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, body, _, _ := r.messageRow(t, it.ThreadRoot); body != "Merge?\n\nCI is green\n\nRecommended: Merge" {
		t.Fatalf("body %q", body)
	}
}

func TestAnEmptyContextWritesNothing(t *testing.T) {
	r := newWakeRig(t)
	for _, ctxText := range []string{"", "   "} {
		if _, err := r.move(t, "start", "a", item.Fields{Title: "X", Context: ctxText}, nil); !errors.Is(err, item.ErrText) {
			t.Fatalf("context %q: %v", ctxText, err)
		}
	}
	var msgs, items int
	_ = r.s.Store.Reader.SQL().QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&msgs)
	_ = r.s.Store.Reader.SQL().QueryRow(`SELECT COUNT(*) FROM feed_items`).Scan(&items)
	if msgs != 0 || items != 0 {
		t.Fatalf("nothing written: %d messages, %d items", msgs, items)
	}
}

func TestAnAppRidesOnTheItemsMessage(t *testing.T) {
	r := newWakeRig(t)
	raw, err := os.ReadFile("../../../../../schemas/examples/valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var ex []struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &ex); err != nil {
		t.Fatal(err)
	}
	it, err := r.move(t, "block", "c", item.Fields{Title: "Pick", Context: "See the chart"}, ex[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, app, _ := r.messageRow(t, it.ThreadRoot); app == "" {
		t.Fatal("the item's message carries the app")
	}
}
