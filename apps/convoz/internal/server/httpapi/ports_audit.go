package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// postAuditPort writes the audit line of a post. No-op until its work package lands.
type postAuditPort struct{}

func (postAuditPort) MessagePosted(context.Context, pdb.DBTX, time.Time, int64, message.Message) error {
	return nil
}
