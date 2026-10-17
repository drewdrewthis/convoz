package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// postAuditPort writes the audit line of a post in the post's own transaction (I-4), naming the session and so the machine (I-40).
// The detail holds ids only: never the body.
type postAuditPort struct{ p authz.Principal }

func (a postAuditPort) MessagePosted(ctx context.Context, d pdb.DBTX, now time.Time, session int64, m message.Message) error {
	return audit.Write(ctx, d, now, audit.Entry{
		Actor: m.AuthorID, Device: a.p.DeviceID, Machine: a.p.MachineID, Session: session,
		Action: "message.post", TargetKind: "message", TargetID: m.ID, Detail: map[string]any{"conversation_id": m.ConversationID},
	})
}
