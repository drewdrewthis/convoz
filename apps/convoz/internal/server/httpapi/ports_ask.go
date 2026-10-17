package httpapi

import (
	"context"
	"fmt"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// askEffects collects the identities whose inbox got an item while an ask changed, so the handler wakes their long polls
// after the commit.
type askEffects struct{ wake []int64 }

// askPorts wires the ask module to the other modules for the caller p. The answer message is written as the caller; the
// ask message is written as the asking agent.
func askPorts(p authz.Principal, fx *askEffects) ask.Ports {
	return ask.Ports{
		Messages: askMessages{p, fx}, Conversations: askConversations{}, Inbox: askInbox{fx}, Journal: askJournal{}, Notify: askNotify{},
	}
}

// askMessages writes the two kinds of message an ask has, through message.Post.
type askMessages struct {
	p  authz.Principal
	fx *askEffects
}

func (m askMessages) PostAsk(ctx context.Context, d pdb.DBTX, now time.Time, a ask.AskMessage) (int64, bool, error) {
	posted, err := message.Post(ctx, d, messagePorts(m.p), now, message.Draft{
		Conversation: a.Conversation, Author: a.Author, Session: a.Session, Origin: message.Origin{Label: a.OriginLabel, Machine: a.OriginMachine},
		ClientID: a.ClientID, Body: a.Question, Format: "plain", ThreadRoot: a.ThreadRoot, Kind: "ask", App: a.App,
	})
	if err != nil {
		return 0, false, err
	}
	m.fx.wake = append(m.fx.wake, posted.Wake...)
	return posted.Message.ID, posted.Replayed, nil
}

func (m askMessages) PostAnswer(ctx context.Context, d pdb.DBTX, now time.Time, a ask.AnswerMessage) error {
	root, _, err := message.GetAny(ctx, d, a.Ask)
	if err != nil {
		return err
	}
	posted, err := message.Post(ctx, d, messagePorts(m.p), now, message.Draft{
		Conversation: a.Conversation, Author: a.Author, Device: a.Device, ClientID: fmt.Sprintf("ask-%d-answer", a.Ask), Body: a.Text, Format: "plain",
		ThreadRoot: root.ThreadRootID, AnswersAsk: a.Ask,
	})
	if err == nil {
		m.fx.wake = append(m.fx.wake, posted.Wake...)
	}
	return err
}

// askConversations is the conversation side of an ask.
type askConversations struct{}

func (askConversations) AddOpenAsks(ctx context.Context, d pdb.DBTX, conv, delta int64) error {
	return conversation.AddOpenAsks(ctx, d, conv, delta)
}

func (askConversations) AskerActive(ctx context.Context, d pdb.DBTX, conv, asker int64) (bool, error) {
	seat, seated, err := conversation.SeatOf(ctx, d, conv, asker)
	if err != nil || !seated || seat.Status != conversation.StatusActive {
		return false, err
	}
	who, found, err := identity.ByID(ctx, d, asker)
	return found && !who.Disabled, err
}

// askInbox puts the "your ask was resolved" item in the asking agent's inbox.
type askInbox struct{ fx *askEffects }

func (i askInbox) AskResolved(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv, askMessage, sourceSeq int64) error {
	i.fx.wake = append(i.fx.wake, agent)
	return inbox.AskResolved(ctx, d, now, agent, conv, askMessage, sourceSeq)
}

// askJournal writes the thin events of the ask module.
type askJournal struct{}

func (askJournal) Write(ctx context.Context, d pdb.DBTX, now time.Time, c ask.Change) (int64, error) {
	return event.Write(ctx, d, now, event.Entry{
		Type: c.Type, Actor: c.Actor, Session: c.Session, Conversation: c.Conversation, Audience: c.Audience, Message: c.Message, Payload: c.Payload,
	})
}

// askNotify is the notifier of every ask call but the wake: only a snooze that woke notifies, and wakeSnoozes passes pushWake for it.
type askNotify struct{}

func (askNotify) SnoozeWoke(context.Context, pdb.DBTX, time.Time, int64, int64, int64, int64) error {
	return nil
}

// askCascade closes the ask of a message that is deleted, and scrubs it when the message is purged. It joins the delete and
// the purge of every message through messagePorts (a message that carries no ask is left alone).
type askCascade struct{}

func (askCascade) MessageDeleted(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message) error {
	if m.Kind != "ask" {
		return nil
	}
	return ask.MessageDeleted(ctx, d, askPorts(authz.Principal{}, &askEffects{}), now, m.ID)
}

func (askCascade) MessagePurged(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message) error {
	if m.Kind != "ask" {
		return nil
	}
	return ask.MessagePurged(ctx, d, now, m.ID)
}
