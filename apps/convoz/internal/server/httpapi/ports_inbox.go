package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

type inboxPort struct{}

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error {
	return inbox.FanOut(ctx, d, now, identity, conv, messageID, sourceSeq)
}
