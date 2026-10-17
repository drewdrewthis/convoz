package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// searchPort indexes a new message for full-text search, in the message transaction. No-op until its work package lands.
type searchPort struct{}

func (searchPort) IndexMessage(context.Context, pdb.DBTX, time.Time, message.Message) error {
	return nil
}
