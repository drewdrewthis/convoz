package message

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Moved is one reply that left its thread for a conversation of its own.
type Moved struct {
	ID, Author, CreatedAt int64
	Broadcast             bool // it was also in the main list of the conversation it left
}

// RepliesMovable says whether every reply of the thread of root can move. A reply that is an ask, an answer to an ask, an app or an
// app's result is tied by (message, conversation) to rows that stay behind, so a thread holding one stays where it is.
func RepliesMovable(ctx context.Context, d pdb.DBTX, root int64) (bool, error) {
	n, err := db.New(d).UnmovableReplies(ctx, nullInt(root))
	return n == 0, err
}

// MoveReplies moves the replies of the thread of root into conversation to, as top-level messages with their ids, authors, times
// and order kept (a reply to an ask stays; see RepliesMovable), and leaves the root with no replies. It returns what moved, oldest
// first. The caller moves the rows of the other modules that name a conversation.
func MoveReplies(ctx context.Context, d pdb.DBTX, root, to int64) ([]Moved, error) {
	q := db.New(d)
	rows, err := q.ListReplyMoves(ctx, nullInt(root))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	if err = q.MarkThreadMoves(ctx, nullInt(root)); err != nil {
		return nil, err
	}
	if err = q.MoveThreadReplies(ctx, db.MoveThreadRepliesParams{ToConversation: to, RootID: nullInt(root)}); err != nil {
		return nil, err
	}
	if err = q.ClearThreadMoves(ctx); err != nil {
		return nil, err
	}
	if err = q.EmptyThread(ctx, root); err != nil {
		return nil, err
	}
	out := make([]Moved, len(rows))
	for i, r := range rows {
		out[i] = Moved{ID: r.ID, Author: r.AuthorID.Int64, CreatedAt: r.CreatedAt, Broadcast: r.Broadcast == 1}
	}
	return out, nil
}

// NewestMainID is the newest message of the main list of a conversation, 0 for none.
func NewestMainID(ctx context.Context, d pdb.DBTX, conv int64) (int64, error) {
	return db.New(d).NewestMainID(ctx, conv)
}
