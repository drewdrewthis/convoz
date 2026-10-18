package inbox

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MarkSeen records that the identity's claim covers messageID (the newest message of the claimed item), and so every
// message before it. A second claim of the same message keeps the first time.
func MarkSeen(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID int64) error {
	return db.New(d).MarkSeen(ctx, db.MarkSeenParams{IdentityID: identityID, MessageID: messageID, ConversationID: conversationID, Now: now.UnixMilli()})
}

// Seen is one agent that has seen a message, and when.
type Seen struct{ Identity, At int64 }

// SeenSince lists the agents that have seen messageID, first seen first.
func SeenSince(ctx context.Context, d pdb.DBTX, conversationID, messageID int64) ([]Seen, error) {
	rows, err := db.New(d).SeenSince(ctx, db.SeenSinceParams{ConversationID: conversationID, MessageID: messageID})
	out := make([]Seen, 0, len(rows))
	for _, r := range rows {
		out = append(out, Seen{Identity: r.IdentityID, At: r.SeenAt})
	}
	return out, err
}
