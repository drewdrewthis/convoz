package readstate

import (
	"context"
	"database/sql"
	"errors"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate/db"
)

// Thread reads (design §8.2, I-14, DA-3). A thread_reads row says the identity is involved in a thread: it wrote the root,
// replied, or was @mentioned there. Only an involved thread counts as unread, and opening a thread moves an existing row only,
// so the rail query is bounded by the identity's own threads.

// ThreadPos is how far an identity has read one thread.
type ThreadPos struct{ Root, LastRead int64 }

// Floor is the reply id at or below which no thread reply counts as unread: "mark all read" moves it (DA-2).
func Floor(ctx context.Context, d pdb.DBTX, identityID, conversationID int64) (int64, error) {
	v, err := db.New(d).GetThreadFloor(ctx, db.GetThreadFloorParams{IdentityID: identityID, ConversationID: conversationID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return v, err
}

// MoveFloor sets the thread floor to messageID if that is ahead of it ("mark all read").
func MoveFloor(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID int64) (bool, error) {
	n, err := db.New(d).MoveThreadFloor(ctx, db.MoveThreadFloorParams{FloorID: messageID, At: now.UnixMilli(), IdentityID: identityID, ConversationID: conversationID})
	return n > 0, err
}

// Threads lists the threads the identity is involved in, with its read position in each.
func Threads(ctx context.Context, d pdb.DBTX, identityID, conversationID int64) ([]ThreadPos, error) {
	rows, err := db.New(d).ListThreadReads(ctx, db.ListThreadReadsParams{IdentityID: identityID, ConversationID: conversationID})
	out := make([]ThreadPos, len(rows))
	for i, r := range rows {
		out[i] = ThreadPos{Root: r.RootID, LastRead: r.LastReadID}
	}
	return out, err
}

// Involve makes the identity part of a thread, with everything up to lastRead already read. A thread it is in stays as it is.
func Involve(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, rootID, lastRead int64) error {
	return db.New(d).CreateThreadRead(ctx, db.CreateThreadReadParams{
		IdentityID: identityID, ConversationID: conversationID, RootID: rootID, LastReadID: lastRead, At: now.UnixMilli(),
	})
}

// MoveThreadForOwnReply is the author's rule for a reply (DA-2): the reply marks the thread read only when the author was
// caught up, that is, had read up to the newest reply before this one (prevLast).
func MoveThreadForOwnReply(ctx context.Context, d pdb.DBTX, identityID, conversationID, rootID, prevLast, replyID int64) error {
	_, err := db.New(d).MoveThreadReadIfCaughtUp(ctx, db.MoveThreadReadIfCaughtUpParams{
		ReplyID: replyID, IdentityID: identityID, ConversationID: conversationID, RootID: rootID, PrevLastID: prevLast,
	})
	return err
}

// ReadThread moves the identity's read position in a thread forward to replyID and reports whether it moved. A thread it is not
// involved in has no row, so nothing moves.
func ReadThread(ctx context.Context, d pdb.DBTX, identityID, conversationID, rootID, replyID int64) (bool, error) {
	n, err := db.New(d).MoveThreadRead(ctx, db.MoveThreadReadParams{ReplyID: replyID, IdentityID: identityID, ConversationID: conversationID, RootID: rootID})
	return n > 0, err
}
