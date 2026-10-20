package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// unreadOf is the unread math of design §8.2 (I-14) for one reader and conversation, seen from above floor: the main list after the
// reader's cursor, less the broadcast replies it read in their thread, plus the replies of the threads it is involved in that it has
// not read. Its own, system and deleted messages never count, and a reply in a thread it is not in never counts. A conversation the
// reader has no cursor for counts none. Each part stops at message.MaxUnread, and so does the sum.
func unreadOf(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (int64, error) {
	main, threads, err := unreadParts(ctx, d, reader, cv, floor)
	return min(main+threads, message.MaxUnread), err
}

// unreadParts is unreadOf in two: the unread of the main list, and the unread replies of the threads the reader is in.
func unreadParts(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (mainUnread, threadUnread int64, err error) {
	cursor, found, err := readstate.Cursor(ctx, d, reader, cv.ID)
	if err != nil || !found {
		return 0, 0, err
	}
	threads, err := readstate.Threads(ctx, d, reader, cv.ID)
	if err != nil {
		return 0, 0, err
	}
	after := max(cursor, floor)
	var readInThread int64
	for _, t := range threads {
		n, err := message.CountBroadcastRead(ctx, d, t.Root, after, t.LastRead, reader)
		if err != nil {
			return 0, 0, err
		}
		readInThread += n
	}
	if cv.LastMainID > after {
		raw, err := message.CountMainUnread(ctx, d, cv.ID, after, reader, message.MaxUnread+readInThread)
		if err != nil {
			return 0, 0, err
		}
		mainUnread = min(max(raw-readInThread, 0), message.MaxUnread)
	}
	if len(threads) == 0 {
		return mainUnread, 0, nil
	}
	threadFloor, err := readstate.Floor(ctx, d, reader, cv.ID)
	if err != nil {
		return 0, 0, err
	}
	for _, t := range threads {
		if mainUnread+threadUnread >= message.MaxUnread {
			break
		}
		n, err := message.CountThreadUnread(ctx, d, t.Root, max(t.LastRead, threadFloor, floor), reader)
		if err != nil {
			return 0, 0, err
		}
		threadUnread += n
	}
	return mainUnread, threadUnread, nil
}

// maxThreadRows bounds the threads a conversation row lists.
const maxThreadRows = 30

// threadRowsOf lists the threads of a conversation for the reader, newest reply first. A thread's unread count is per thread: the
// replies after the reader's position in it, or after the thread floor in a thread it has no position in (owner, msg 1855: a thread
// with new agent replies shows as new on the rail even where the owner never wrote). The conversation's own count keeps DA-3.
func threadRowsOf(ctx context.Context, d pdb.DBTX, p authz.Principal, dir directory, cv conversation.Conversation, floor int64) ([]wire.ThreadRow, error) {
	roots, err := message.ThreadRoots(ctx, d, cv.ID, floor, maxThreadRows)
	if err != nil || len(roots) == 0 {
		return nil, err
	}
	reader := p.Identity()
	pos, err := readstate.Threads(ctx, d, reader, cv.ID)
	if err != nil {
		return nil, err
	}
	threadFloor, err := readstate.Floor(ctx, d, reader, cv.ID)
	if err != nil {
		return nil, err
	}
	out := make([]wire.ThreadRow, 0, len(roots))
	for _, r := range roots {
		last, err := lastReplyOf(ctx, d, dir, p, cv.ID, r.ID)
		if err != nil {
			return nil, err
		}
		if last == nil {
			continue
		}
		row := wire.ThreadRow{RootID: r.ID, Author: dir.person(r.AuthorID), Preview: message.Preview(r.Body), ReplyCount: r.ReplyCount, LastReply: last, LastReplyAt: last.CreatedAt}
		after := max(threadFloor, floor)
		for _, t := range pos {
			if t.Root == r.ID {
				after = max(t.LastRead, after)
			}
		}
		if row.Unread, err = message.CountThreadUnread(ctx, d, r.ID, after, reader); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}
