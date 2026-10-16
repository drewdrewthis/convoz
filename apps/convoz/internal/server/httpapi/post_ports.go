package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// messagePorts wires message.Post to the conversation, readstate, inbox and event modules for the caller p.
func messagePorts(p authz.Principal) message.Ports {
	return message.Ports{Conversations: conversationPort{p}, Reads: readsPort{}, Inbox: inboxPort{}, Journal: messageJournal{}}
}

// conversationPort answers for the conversation module and for who may post in it.
type conversationPort struct{ p authz.Principal }

func (a conversationPort) Access(ctx context.Context, d pdb.DBTX, conv int64) (message.Access, error) {
	_, found, err := conversation.Get(ctx, d, conv)
	if err != nil {
		return message.Denied, err
	}
	_, visible, err := canSee(ctx, d, a.p, conv)
	switch {
	case err != nil:
		return message.Denied, err
	case visible:
		return message.Allowed, nil
	case !found && a.p.SessionID == 0:
		return message.Missing, nil
	}
	return message.Denied, nil // an agent is told 403 whether or not the conversation exists
}

func (conversationPort) RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64, body string) (int64, error) {
	return conversation.RecordMainPost(ctx, d, now, conv, messageID, body)
}

func (conversationPort) AgentRecipients(ctx context.Context, d pdb.DBTX, conv, author int64) ([]int64, error) {
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	parts, err := conversation.Participants(ctx, d, conv)
	if err != nil {
		return nil, err
	}
	var out []int64
	for _, pt := range parts {
		if e := dir[pt.IdentityID]; e.Kind == "agent" && !e.Disabled && pt.IdentityID != author {
			out = append(out, pt.IdentityID)
		}
	}
	return out, nil
}

type readsPort struct{}

func (readsPort) MoveForOwnPost(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, prevLastMain, mainID int64) (bool, error) {
	return readstate.MoveForOwnPost(ctx, d, now, reader, conv, prevLastMain, mainID)
}

type inboxPort struct{}

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error {
	return inbox.FanOut(ctx, d, now, identity, conv, messageID, sourceSeq)
}

type messageJournal struct{}

func (messageJournal) MessageCreated(ctx context.Context, d pdb.DBTX, now time.Time, c message.Created) (int64, error) {
	return event.Write(ctx, d, now, event.Entry{
		Type: event.MessageCreated, Actor: c.Actor, Session: c.Session, Conversation: c.Conversation, Message: c.Message,
		IdemKey: c.IdemKey, Payload: map[string]any{"id": c.Message, "kind": "text", "conversation_id": c.Conversation},
	})
}

func (messageJournal) ReadMoved(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, mainID int64) error {
	_, err := event.Write(ctx, d, now, event.Entry{Type: event.ReadMoved, Actor: reader, Conversation: conv, Audience: reader, Payload: map[string]any{"main_id": mainID}})
	return err
}
