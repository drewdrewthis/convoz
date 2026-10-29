package inbox

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// ReasonItemStale reminds an agent that a feed item it started went quiet. It names the feed item and no message; it never merges.
const ReasonItemStale = "item_stale"

// ItemStale reminds the agent about its quiet feed item in the conversation.
func ItemStale(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, feedItemID int64) error {
	return db.New(d).InsertItemStaleItem(ctx, db.InsertItemStaleItemParams{IdentityID: identityID, ConversationID: nullInt(conversationID),
		FeedItemID: nullInt(feedItemID), Now: now.UnixMilli()})
}

// ItemStaleOf is the feed item an item_stale reminder is about.
func ItemStaleOf(ctx context.Context, d pdb.DBTX, identityID, inboxItemID int64) (int64, error) {
	return db.New(d).ItemStaleOf(ctx, db.ItemStaleOfParams{ID: inboxItemID, IdentityID: identityID})
}
