package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/unfurl"
)

// unfurlPort queues the link preview of a new message, in the message transaction and without a network call: the worker
// (RunUnfurls) fetches after the commit.
type unfurlPort struct{}

func (unfurlPort) QueueUnfurl(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	if m.Kind == "system" || m.Deleted {
		return nil
	}
	return unfurl.Queue(ctx, d, m.Body)
}
