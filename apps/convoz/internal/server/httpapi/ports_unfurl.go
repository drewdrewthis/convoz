package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// unfurlPort queues the link preview of a new message. No-op until its work package lands.
type unfurlPort struct{}

func (unfurlPort) QueueUnfurl(context.Context, pdb.DBTX, time.Time, message.Message) error {
	return nil
}
