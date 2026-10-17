package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// unreadOf is the unread math of design §8.2 (I-14) for one reader and conversation, seen from above floor: the main list after the
// reader's cursor, less the broadcast replies it read in their thread, plus the replies of the threads it is involved in that it has
// not read. Its own, system and deleted messages never count, and a reply in a thread it is not in never counts. A conversation the
// reader has no cursor for counts none. Each part stops at message.MaxUnread, and so does the sum.
func unreadOf(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (int64, error) {
	cursor, found, err := readstate.Cursor(ctx, d, reader, cv.ID)
	if err != nil || !found {
		return 0, err
	}
	threads, err := readstate.Threads(ctx, d, reader, cv.ID)
	if err != nil {
		return 0, err
	}
	after := max(cursor, floor)
	var readInThread int64
	for _, t := range threads {
		n, err := message.CountBroadcastRead(ctx, d, t.Root, after, t.LastRead, reader)
		if err != nil {
			return 0, err
		}
		readInThread += n
	}
	var total int64
	if cv.LastMainID > after {
		raw, err := message.CountMainUnread(ctx, d, cv.ID, after, reader, message.MaxUnread+readInThread)
		if err != nil {
			return 0, err
		}
		total = min(max(raw-readInThread, 0), message.MaxUnread)
	}
	if len(threads) == 0 {
		return total, nil
	}
	threadFloor, err := readstate.Floor(ctx, d, reader, cv.ID)
	if err != nil {
		return 0, err
	}
	for _, t := range threads {
		if total >= message.MaxUnread {
			break
		}
		n, err := message.CountThreadUnread(ctx, d, t.Root, max(t.LastRead, threadFloor, floor), reader)
		if err != nil {
			return 0, err
		}
		total += n
	}
	return min(total, message.MaxUnread), nil
}
