package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

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
