package httpapi

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

type readsPort struct{}

func (readsPort) MoveForOwnPost(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, prevLastMain, mainID int64) (bool, error) {
	return readstate.MoveForOwnPost(ctx, d, now, reader, conv, prevLastMain, mainID)
}
