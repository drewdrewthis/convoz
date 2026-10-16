// Package readstate owns the read_cursors table: how far each identity has read each conversation's main thread.
// Cursors only move forward (the schema enforces it). The unread count joins this with messages, which another
// module owns, so the composition root does that join.
package readstate

import (
	"context"
	"database/sql"
	"errors"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate/db"
)

// Create makes the cursor of a new participant, at the conversation's newest message so that history is not "unread" (DA-4).
// An existing cursor stays.
func Create(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, atMessageID int64) error {
	return db.New(d).CreateCursor(ctx, db.CreateCursorParams{IdentityID: identityID, ConversationID: conversationID, AtMessageID: atMessageID, At: now.UnixMilli()})
}

// Cursor returns the last main message the identity has read; found is false when it has no cursor.
func Cursor(ctx context.Context, d pdb.DBTX, identityID, conversationID int64) (lastRead int64, found bool, err error) {
	v, err := db.New(d).GetCursor(ctx, db.GetCursorParams{IdentityID: identityID, ConversationID: conversationID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return v, err == nil, err
}

// Move sets the cursor to mainID if that is ahead of it, and reports whether it moved. A lower id is a no-op.
func Move(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, mainID int64) (bool, error) {
	n, err := db.New(d).MoveCursor(ctx, db.MoveCursorParams{MainID: mainID, At: now.UnixMilli(), IdentityID: identityID, ConversationID: conversationID})
	return n > 0, err
}

// MoveForOwnPost is the author's cursor rule (DA-2, I-15): a post marks the conversation read only when the author
// was caught up, that is, its cursor was at the newest main message just before the post (prevLastMain).
func MoveForOwnPost(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, prevLastMain, mainID int64) (bool, error) {
	n, err := db.New(d).MoveCursorIfCaughtUp(ctx, db.MoveCursorIfCaughtUpParams{
		MainID: mainID, At: now.UnixMilli(), IdentityID: identityID, ConversationID: conversationID, PrevLastMainID: prevLastMain,
	})
	return n > 0, err
}
