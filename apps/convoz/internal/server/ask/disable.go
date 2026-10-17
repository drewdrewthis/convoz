package ask

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// CloseForDisable closes every open and dismissed ask of an agent that was disabled (I-38): each goes to "closed" with the reason
// "agent_revoked". It returns, per conversation, how many were open, so the caller can correct the open-ask counters.
func CloseForDisable(ctx context.Context, d pdb.DBTX, now time.Time, agentID int64) (wasOpen map[int64]int64, err error) {
	q := db.New(d)
	rows, err := q.AsksToCloseOnDisable(ctx, agentID)
	if err != nil {
		return nil, err
	}
	wasOpen = map[int64]int64{}
	for _, r := range rows {
		if err := q.CloseAskAgentRevoked(ctx, db.CloseAskAgentRevokedParams{Now: now.UnixMilli(), MessageID: r.MessageID}); err != nil {
			return nil, err
		}
		if err := q.InsertAskTransition(ctx, db.InsertAskTransitionParams{MessageID: r.MessageID, Version: r.Version + 1, Event: "close", ToState: "closed", At: now.UnixMilli()}); err != nil {
			return nil, err
		}
		if r.State == "open" {
			wasOpen[r.ConversationID]++
		}
	}
	return wasOpen, nil
}
