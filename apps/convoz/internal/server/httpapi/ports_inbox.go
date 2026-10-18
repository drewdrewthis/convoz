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

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity int64, a message.Arrival) error {
	m := a.Message
	if m.ViaAgentID == identity {
		return inbox.AppResult(ctx, d, now, identity, m.ConversationID, m.ID, a.SourceSeq) // the agent whose app it was: its own item, never merged
	}
	prefer, err := conversation.LastPostSession(ctx, d, m.ConversationID, identity)
	if err != nil {
		return err
	}
	if err := inbox.FanOut(ctx, d, now, identity, m.ConversationID, m.ID, a.SourceSeq, prefer, reasonFor(identity, a)); err != nil {
		return err
	}
	if !a.HasUploads {
		return nil
	}
	return holdForWords(ctx, d, now, m.ConversationID, m.ID)
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

// reasonFor is "mention" when the message mentions the agent, "thread" for any other reply in a thread, else "activity".
func reasonFor(identity int64, a message.Arrival) string {
	switch {
	case slices.Contains(a.Mentioned, identity):
		return inbox.ReasonMention
	case a.Message.ThreadRootID != 0:
		return inbox.ReasonThread
	}
	return inbox.ReasonActivity
}
