package prefs

import (
	"context"
	"database/sql"
	"errors"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs/db"
)

// Conversation is one person's star and mute of one conversation. A conversation they never touched has the zero value.
type Conversation struct {
	Starred    bool
	MutedUntil int64 // unix ms; 0 for not muted
}

// OfConversation reads the person's prefs for one conversation.
func OfConversation(ctx context.Context, d pdb.DBTX, identityID, conversationID int64) (Conversation, error) {
	r, err := db.New(d).GetConversationPrefs(ctx, db.GetConversationPrefsParams{IdentityID: identityID, ConversationID: conversationID})
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, nil
	}
	return Conversation{Starred: r.StarredAt.Valid, MutedUntil: r.MutedUntil.Int64}, err
}

// StarredByAnyone reports whether any person starred the conversation (the empty-conversation cleanup keeps those).
func StarredByAnyone(ctx context.Context, d pdb.DBTX, conversationID int64) (bool, error) {
	n, err := db.New(d).IsStarredByAnyone(ctx, conversationID)
	return n > 0, err
}
