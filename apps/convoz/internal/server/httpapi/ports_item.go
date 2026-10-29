package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// itemReplyPort brings a feed item back to the owner when an agent writes in its thread (the item module owns the table).
type itemReplyPort struct{}

func (itemReplyPort) AgentReplied(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message) ([]int64, error) {
	return item.AgentReplied(ctx, d, now, m.ConversationID, m.ThreadRootID, m.AuthorID)
}

func (itemReplyPort) OwnerReplied(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message) error {
	return item.OwnerRepliedIn(ctx, d, now, m.AuthorID, m.ConversationID, m.ThreadRootID)
}
