package item

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// takeNote marks the first event of an item that answers a question of the owner: the item module tells such an item from the others by it.
const takeNote = "take"

// Take makes the items of a question the agent takes on the owner's message (owner, conv 179 msg 12472, 12583): the question, started, and
// each research step pending after it, all rooted at the message. asked says the agent named the question; without it a message that
// already has an item is ErrConflict. The keys are made here. Nothing is posted.
func Take(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv, root int64, f Fields, steps []string, asked bool) ([]Item, error) {
	f, err := NeedContext(f)
	if err != nil {
		return nil, err
	}
	rows, err := db.New(d).ItemsByRoot(ctx, nint(root))
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if !asked && r.State != Dropped {
			return nil, ErrConflict
		}
	}
	var out []Item
	for i, title := range append([]string{f.Title}, steps...) {
		g := Fields{Title: title, Context: f.Context, Plan: f.Plan, Root: root, Taken: i == 0}
		if g, err = g.check(); err != nil {
			return nil, err
		}
		key, err := freeKey(ctx, d, agent, conv, root)
		if err != nil {
			return nil, err
		}
		it, err := create(ctx, d, now, agent, conv, key, g, false)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

// freeKey is m<root>-<n>, the first n no item of the agent in the conversation holds.
func freeKey(ctx context.Context, d pdb.DBTX, agent, conv, root int64) (string, error) {
	for n := 1; ; n++ {
		key := fmt.Sprintf("m%d-%d", root, n)
		if _, err := ByKey(ctx, d, agent, conv, key); err == ErrNotFound {
			return key, nil
		} else if err != nil {
			return "", err
		}
	}
}

// IsQuestion says whether the item was taken from a message of the owner: its first event carries the take note.
func IsQuestion(ctx context.Context, d pdb.DBTX, id int64) (bool, error) {
	evs, err := Events(ctx, d, id)
	return err == nil && len(evs) > 0 && strings.HasPrefix(evs[0].Note, takeNote), err
}
