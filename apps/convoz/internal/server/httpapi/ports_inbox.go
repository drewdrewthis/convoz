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

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity int64, a message.Arrival) (bool, error) {
	m := a.Message
	if m.ViaAgentID == identity {
		return true, inbox.AppResult(ctx, d, now, identity, m.ConversationID, m.ID, a.SourceSeq) // the agent whose app it was: its own item, never merged
	}
	if ok, err := wakes(ctx, d, identity, a); err != nil || !ok {
		return false, err
	}
	prefer, err := conversation.LastPostSession(ctx, d, m.ConversationID, identity)
	if err != nil {
		return false, err
	}
	if err := inbox.FanOut(ctx, d, now, identity, m.ConversationID, m.ID, a.SourceSeq, prefer, reasonFor(identity, a)); err != nil {
		return false, err
	}
	if !a.HasUploads {
		return true, nil
	}
	return true, holdForWords(ctx, d, now, m.ConversationID, m.ID)
}

// wakes is whether the message gives this agent an item. A person's message always does. An agent's message does only when it
// @mentions the agent or is a reply in a thread the agent wrote the root of or already replied in: agents must not wake each
// other by chatter (owner's rule, conv 252 msg 5447).
func wakes(ctx context.Context, d pdb.DBTX, identity int64, a message.Arrival) (bool, error) {
	if !a.ByAgent || a.Owns || slices.Contains(a.Mentioned, identity) {
		return true, nil
	}
	if a.Message.ThreadRootID == 0 {
		return false, nil
	}
	return message.WroteInThread(ctx, d, a.Message.ThreadRootID, identity)
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

// placesPort tells the inbox which place the owner last wrote in, or that someone else answered there. A counted message is a text or
// an ask. Plan updates are no messages, system lines are kind system, and a result sent through an app or the answer to an ask has
// its own item already: none of these counts either way. An agent's ask clears the place: it is a response to what the owner wrote
// (it asks the owner for the next step), so the agent is not silent.
type placesPort struct{ owner bool }

func (pp placesPort) Posted(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	if m.Kind == "system" || m.ViaAppID != 0 || m.AnswersAskID != 0 {
		return nil
	}
	place := inbox.Place{Conversation: m.ConversationID, ThreadRoot: m.ThreadRootID}
	if pp.owner {
		return inbox.OwnerSpoke(ctx, d, place, m.ID, m.CreatedAt)
	}
	return inbox.Answered(ctx, d, place)
}
