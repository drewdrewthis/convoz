package item

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Feed is what GET /api/feed lists: the open steps in plan order (per conversation and agent) and the last finished ones.
type Feed struct {
	Open []Item
	Done []Item
}

// List reads the feed; maxDone bounds the finished items.
func List(ctx context.Context, d pdb.DBTX, maxDone int) (Feed, error) {
	q := db.New(d)
	open, err := q.OpenItems(ctx)
	if err != nil {
		return Feed{}, err
	}
	done, err := q.RecentDone(ctx, int64(maxDone))
	if err != nil {
		return Feed{}, err
	}
	var f Feed
	for _, r := range open {
		f.Open = append(f.Open, fromRow(r))
	}
	for _, r := range done {
		f.Done = append(f.Done, fromRow(r))
	}
	return f, nil
}
