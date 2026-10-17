package notify

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Logged is one row of the notification log.
type Logged struct {
	ID, Identity          int64
	Reason, Decision, Why string
	Conversation, Message int64
}

// maxLogged bounds one read of the log.
const maxLogged = 500

// Log reads the newest rows of the notification log, oldest first.
func Log(ctx context.Context, d pdb.DBTX) ([]Logged, error) {
	rows, err := db.New(d).ListNotifications(ctx, maxLogged)
	if err != nil {
		return nil, err
	}
	out := make([]Logged, 0, len(rows))
	for _, r := range rows {
		out = append(out, Logged{ID: r.ID, Identity: r.IdentityID, Reason: r.Reason, Decision: r.Decision, Why: r.SuppressedReason.String, Conversation: r.ConversationID.Int64, Message: r.MessageID.Int64})
	}
	return out, nil
}
