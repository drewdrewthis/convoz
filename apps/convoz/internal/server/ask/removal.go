package ask

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// CloseForRemoval closes the open and the dismissed asks an agent has in a conversation it was removed from or left
// (I-19): each goes to "closed" with the reason "removed", and the history records the system as the one who did it.
// It returns how many of them were open, so the caller can correct the conversation's open-ask counter.
func CloseForRemoval(ctx context.Context, d pdb.DBTX, now time.Time, conversationID, agentID int64) (wasOpen int64, err error) {
	q := db.New(d)
	rows, err := q.AsksToCloseOnRemoval(ctx, db.AsksToCloseOnRemovalParams{ConversationID: conversationID, AskerID: agentID})
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		if err := q.CloseAskRemoved(ctx, db.CloseAskRemovedParams{Now: now.UnixMilli(), MessageID: r.MessageID}); err != nil {
			return 0, err
		}
		if err := q.InsertAskTransition(ctx, db.InsertAskTransitionParams{MessageID: r.MessageID, Version: r.Version + 1, Event: "close", ToState: "closed", At: now.UnixMilli()}); err != nil {
			return 0, err
		}
		if r.State == "open" {
			wasOpen++
		}
	}
	return wasOpen, nil
}
