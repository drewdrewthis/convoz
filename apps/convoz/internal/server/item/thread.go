package item

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// SetThreadRoot keeps the message an item's thread hangs on. It sets it once: an item that has a root keeps it.
func SetThreadRoot(ctx context.Context, d pdb.DBTX, id, root int64) error {
	return db.New(d).SetThreadRoot(ctx, db.SetThreadRootParams{ThreadRootID: nint(root), ID: id})
}
