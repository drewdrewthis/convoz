package httpapi

import (
	"context"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// inboxPort queues a new message for one agent with the strongest reason it gives (C-10).
type inboxPort struct{}

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error {
	if m, found, err := message.Get(ctx, d, messageID); err != nil {
		return err
	} else if found && m.ViaAgentID == identity {
		return inbox.AppResult(ctx, d, now, identity, conv, messageID, sourceSeq) // the agent whose app it was: its own item, never merged
	}
	reason, err := reasonFor(ctx, d, identity, messageID)
	if err != nil {
		return err
	}
	return inbox.FanOut(ctx, d, now, identity, conv, messageID, sourceSeq, reason)
}

// reasonFor is "mention" when the message mentions the agent (the mentions table, written when the message was), "thread"
// for any other reply in a thread, else "activity".
func reasonFor(ctx context.Context, d pdb.DBTX, identity, messageID int64) (string, error) {
	m, found, err := message.Get(ctx, d, messageID)
	if err != nil || !found {
		return inbox.ReasonActivity, err
	}
	named, err := message.Mentioned(ctx, d, messageID)
	switch {
	case err != nil:
		return "", err
	case slices.Contains(named, identity):
		return inbox.ReasonMention, nil
	case m.ThreadRootID != 0:
		return inbox.ReasonThread, nil
	}
	return inbox.ReasonActivity, nil
}
