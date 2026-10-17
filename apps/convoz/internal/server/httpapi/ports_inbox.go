package httpapi

import (
	"context"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

// inboxPort queues a new message for one agent with the strongest reason it gives (C-10).
type inboxPort struct{}

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error {
	reason, err := reasonFor(ctx, d, identity, messageID)
	if err != nil {
		return err
	}
	prefer, err := conversation.LastPostSession(ctx, d, conv, identity)
	if err != nil {
		return err
	}
	if err := inbox.FanOut(ctx, d, now, identity, conv, messageID, sourceSeq, prefer, reason); err != nil {
		return err
	}
	return holdForWords(ctx, d, now, conv, messageID)
}

// holdForWords makes the item of a voice note wait for its transcript (E-5): only while an engine works on it.
func holdForWords(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64) error {
	by, err := attachmentsOf(ctx, d, []int64{messageID})
	if err != nil {
		return err
	}
	for _, a := range by[messageID] {
		if a.Transcript != nil && a.Transcript.State == transcript.Pending {
			return inbox.HoldForVoice(ctx, d, now, conv, messageID)
		}
	}
	return nil
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
