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

// Around is where a message sits: its thread root and the message just before it in the same place. A zero field is none.
// BeforeID and RootID let the caller drop what the reader may not see (an id at or under their floor).
type Around struct {
	RootID, BeforeID, BeforeAuthorID int64
	RootBody, BeforeBody             string
}

// AroundMessages reads Around for a batch of messages in one query, keyed by message id.
func AroundMessages(ctx context.Context, d pdb.DBTX, ids []int64) (map[int64]Around, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.New(d).WatchContext(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Around, len(rows))
	for _, r := range rows {
		out[r.MessageID] = Around{RootID: r.RootID, RootBody: r.RootBody, BeforeID: r.BeforeID, BeforeAuthorID: r.BeforeAuthorID, BeforeBody: r.BeforeBody}
	}
	return out, nil
}

// ContextRunes is the longest a thread topic or a "before" text goes in an inbox item: the "…" counts in it.
const ContextRunes = 120

// Excerpt is the plain one-line text of a body cut to ContextRunes runes. A cut text ends in "…"; the cut falls on a rune
// boundary, never inside a multibyte character.
func Excerpt(body string) string {
	r := []rune(Preview(body))
	if len(r) <= ContextRunes {
		return string(r)
	}
	return string(r[:ContextRunes-1]) + "…"
}
