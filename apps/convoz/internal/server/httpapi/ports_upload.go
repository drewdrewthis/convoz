package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// uploadPort binds the uploads a message carries. No-op until its work package lands.
type uploadPort struct{}

func (uploadPort) BindUploads(context.Context, pdb.DBTX, time.Time, message.Message, []string) error {
	return nil
}
