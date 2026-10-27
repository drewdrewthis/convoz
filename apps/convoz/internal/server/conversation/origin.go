package conversation

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Origin is where a conversation came from: the message a thread hangs off, in the conversation it was written in.
type Origin struct{ Conversation, Source, Message int64 }

func fromOrigin(r db.ConversationOrigin) Origin {
	return Origin{Conversation: r.ConversationID, Source: r.SourceConversationID, Message: r.MessageID}
}

// SetOrigin records that conversation conv was made from message msg of conversation source.
func SetOrigin(ctx context.Context, d pdb.DBTX, now time.Time, conv, source, msg int64) error {
	return db.New(d).InsertOrigin(ctx, db.InsertOriginParams{ConversationID: conv, SourceConversationID: source, MessageID: msg, CreatedAt: now.UnixMilli()})
}

// OriginOf is the origin of conversation conv; found is false for one that was not made from a thread.
func OriginOf(ctx context.Context, d pdb.DBTX, conv int64) (o Origin, found bool, err error) {
	r, err := db.New(d).GetOrigin(ctx, conv)
	if errors.Is(err, sql.ErrNoRows) {
		return Origin{}, false, nil
	}
	return fromOrigin(r), err == nil, err
}

// OriginFromMessage is the conversation already made from message msg; found is false when there is none.
func OriginFromMessage(ctx context.Context, d pdb.DBTX, msg int64) (o Origin, found bool, err error) {
	r, err := db.New(d).GetOriginOfMessage(ctx, msg)
	if errors.Is(err, sql.ErrNoRows) {
		return Origin{}, false, nil
	}
	return fromOrigin(r), err == nil, err
}
