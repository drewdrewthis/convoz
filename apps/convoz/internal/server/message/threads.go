package message

import (
	"context"
	"database/sql"
	"errors"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// PrevReplyID is the newest reply to root before message `before`, 0 for none: where a thread stood just before a reply.
func PrevReplyID(ctx context.Context, d pdb.DBTX, root, before int64) (int64, error) {
	return db.New(d).PrevReplyID(ctx, db.PrevReplyIDParams{RootID: nullInt(root), BeforeID: before})
}

// NewestReplyID is the newest reply to root, 0 for none.
func NewestReplyID(ctx context.Context, d pdb.DBTX, root int64) (int64, error) {
	return db.New(d).NewestReplyID(ctx, nullInt(root))
}

// CountThreadUnread counts the replies to root after `after` that someone else wrote and that are not in the main list too
// (a broadcast counts once, in the main list), stopping at MaxUnread.
func CountThreadUnread(ctx context.Context, d pdb.DBTX, root, after, reader int64) (int64, error) {
	return db.New(d).CountThreadUnread(ctx, db.CountThreadUnreadParams{RootID: nullInt(root), After: after, ReaderID: nullInt(reader), MaxRows: MaxUnread})
}

// CountBroadcastRead counts the broadcast replies to root in (after, upTo] that someone else wrote: the ones the reader read
// in the thread, which the main list must not count again (I-14).
func CountBroadcastRead(ctx context.Context, d pdb.DBTX, root, after, upTo, reader int64) (int64, error) {
	return db.New(d).CountBroadcastRead(ctx, db.CountBroadcastReadParams{RootID: nullInt(root), After: after, UpTo: upTo, ReaderID: nullInt(reader)})
}

// CountMainUnread counts the main-list messages after `after` that someone else wrote, stopping at max. Unlike CountUnread the
// caller picks the stop, so it can add back the broadcast replies it takes away.
func CountMainUnread(ctx context.Context, d pdb.DBTX, conv, after, reader, max int64) (int64, error) {
	return db.New(d).CountUnread(ctx, db.CountUnreadParams{ConversationID: conv, After: after, ReaderID: nullInt(reader), MaxRows: max})
}

// NewestMessageID is the newest message of a conversation, replies included, 0 for none: where "mark all read" puts the thread floor.
func NewestMessageID(ctx context.Context, d pdb.DBTX, conv int64) (int64, error) {
	return db.New(d).NewestMessageID(ctx, conv)
}

// NewestOfAuthors is the newest text message any of authors wrote in one place of a conversation, 0 for none: the main list
// when root is 0, else the thread of root (the root itself counts).
func NewestOfAuthors(ctx context.Context, d pdb.DBTX, conv, root int64, authors []int64) (int64, error) {
	if len(authors) == 0 {
		return 0, nil
	}
	who := make([]sql.NullInt64, len(authors))
	for i, a := range authors {
		who[i] = nullInt(a)
	}
	return db.New(d).NewestOfAuthors(ctx, db.NewestOfAuthorsParams{ConversationID: conv, Root: root, Authors: who})
}

// LastReplyRunes is how much of the newest reply shows under a reply chip.
const LastReplyRunes = 120

// NewestReply is the newest reply of root that still reads (not deleted, not a system line); ok is false for none.
func NewestReply(ctx context.Context, d pdb.DBTX, root int64) (Message, bool, error) {
	r, err := db.New(d).NewestReply(ctx, nullInt(root))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	return fromRow(r), err == nil, err
}

// ReplyPreview is the plain text of a reply cut to LastReplyRunes runes.
func ReplyPreview(body string) string {
	if r := []rune(Preview(body)); len(r) > LastReplyRunes {
		return string(r[:LastReplyRunes])
	} else {
		return string(r)
	}
}

// ThreadRoots lists the top-level messages of a conversation after floor that have replies, newest reply first, at most max.
func ThreadRoots(ctx context.Context, d pdb.DBTX, conv, floor, max int64) ([]Message, error) {
	rows, err := db.New(d).ThreadRoots(ctx, db.ThreadRootsParams{ConversationID: conv, Floor: floor, MaxRows: max})
	return fromRows(rows, false), err
}
