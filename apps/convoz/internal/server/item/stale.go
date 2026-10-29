package item

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// StartedQuietSince lists the started items whose updated_at is at or before cutoff (epoch ms): started and left alone.
func StartedQuietSince(ctx context.Context, d pdb.DBTX, cutoff int64) ([]Item, error) {
	rows, err := db.New(d).StartedQuietSince(ctx, cutoff)
	out := make([]Item, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r))
	}
	return out, err
}
