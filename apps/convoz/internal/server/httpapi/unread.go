package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// unreadOf is the unread math of design §8.2 (I-14) for one reader and conversation, seen from above floor: the main list after the
// reader's cursor, less the broadcast replies it read in their thread, plus the replies of the threads it is involved in that it has
// not read. Its own, system and deleted messages never count, and a reply in a thread it is not in never counts. A conversation the
// reader has no cursor for counts none. Each part stops at message.MaxUnread, and so does the sum.
func unreadOf(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (int64, error) {
	u, err := unreadParts(ctx, d, reader, cv, floor)
	return u.total(), err
}

// unreadState is unreadOf in two, the unread of the main list and the unread replies of the threads the reader is in, with the read
// points they count from, so the counts that build on them (mentions, replies to the reader) use the same cursors.
type unreadState struct {
	main, threads int64
	mainAfter     int64               // the main list counts after this id
	points        []message.ReadPoint // each thread the reader is in, after its own read point
}

// total is the conversation's unread count: both parts, stopping at message.MaxUnread.
func (u unreadState) total() int64 { return min(u.main+u.threads, message.MaxUnread) }

// unreadParts reads the unreadState of one reader and conversation, seen from above floor (see unreadOf).
func unreadParts(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (unreadState, error) {
	cursor, found, err := readstate.Cursor(ctx, d, reader, cv.ID)
	if err != nil || !found {
		return unreadState{}, err
	}
	threads, err := readstate.Threads(ctx, d, reader, cv.ID)
	if err != nil {
		return unreadState{}, err
	}
	u := unreadState{mainAfter: max(cursor, floor)}
	var readInThread int64
	for _, t := range threads {
		n, err := message.CountBroadcastRead(ctx, d, t.Root, u.mainAfter, t.LastRead, reader)
		if err != nil {
			return unreadState{}, err
		}
		readInThread += n
	}
	if cv.LastMainID > u.mainAfter {
		raw, err := message.CountMainUnread(ctx, d, cv.ID, u.mainAfter, reader, message.MaxUnread+readInThread)
		if err != nil {
			return unreadState{}, err
		}
		u.main = min(max(raw-readInThread, 0), message.MaxUnread)
	}
	if len(threads) == 0 {
		return u, nil
	}
	threadFloor, err := readstate.Floor(ctx, d, reader, cv.ID)
	if err != nil {
		return unreadState{}, err
	}
	u.points = make([]message.ReadPoint, len(threads))
	for i, t := range threads {
		u.points[i] = message.ReadPoint{Root: t.Root, After: max(t.LastRead, threadFloor, floor)}
	}
	for _, p := range u.points {
		if u.main+u.threads >= message.MaxUnread {
			break
		}
		n, err := message.CountThreadUnread(ctx, d, p.Root, p.After, reader)
		if err != nil {
			return unreadState{}, err
		}
		u.threads += n
	}
	return u, nil
}

// unreadMentions counts the unread messages of cv that @mention the reader, under the read points of u (owner, conv 179 msg 6018:
// the server counts mentions, so a client need not read every unread message to find them).
func unreadMentions(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, u unreadState) (int64, error) {
	if u.total() == 0 {
		return 0, nil
	}
	return message.CountUnreadMentions(ctx, d, cv.ID, reader, u.mainAfter, u.points)
}

// repliesToYou says whether an agent answered the reader: the main list has unread after a message the reader wrote (the newest one
// it read), or a thread whose root the reader wrote has unread replies. The owner's words that @voice wrote for him count as his.
func repliesToYou(ctx context.Context, d pdb.DBTX, dir directory, reader int64, cv conversation.Conversation, u unreadState, threads []wire.ThreadRow) (bool, error) {
	for _, t := range threads {
		if t.Unread > 0 && t.Author.ID == reader {
			return true, nil
		}
	}
	if u.main == 0 {
		return false, nil
	}
	author, err := message.MainAuthorAt(ctx, d, cv.ID, u.mainAfter)
	return author != 0 && (author == reader || isOwner(dir, reader) && isOwner(dir, author)), err
}

// mentionedConversations counts the conversations p can see, not muted and not in the trash, that have an unread message that
// @mentions p: the Now badge counts them next to the open asks (owner, conv 179 msg 6018). It reads every conversation at once,
// in a fixed number of queries, with the read points unreadParts gives each (issue 105: a read per chat cost 70 ms at 200 chats).
func mentionedConversations(ctx context.Context, d pdb.DBTX, p authz.Principal, now time.Time) (int, error) {
	seats, err := readableSeats(ctx, d, p)
	if err != nil {
		return 0, err
	}
	pf, err := prefs.All(ctx, d, p.Identity())
	if err != nil {
		return 0, err
	}
	positions, err := readstate.Positions(ctx, d, p.Identity())
	if err != nil {
		return 0, err
	}
	places := make([]message.MentionPlace, 0, len(seats))
	for _, s := range seats {
		pos, found := positions[s.Conversation]
		if !found || pf[s.Conversation].MutedUntil > now.UnixMilli() {
			continue
		}
		place := message.MentionPlace{Conversation: s.Conversation, MainAfter: max(pos.Main, s.Floor)}
		for _, t := range pos.Threads {
			place.Points = append(place.Points, message.ReadPoint{Root: t.Root, After: max(t.LastRead, pos.ThreadFloor, s.Floor)})
		}
		places = append(places, place)
	}
	ids, err := message.ConversationsWithUnreadMentions(ctx, d, p.Identity(), places)
	return len(ids), err
}

// readableSeats lists the conversations p reads, with the floor canRead gives each: every live one for the owner, from the
// start; its own active seats for anyone else. A triage agent's right adds none here: canRead only grants it beyond its seats,
// and the list is its seats.
func readableSeats(ctx context.Context, d pdb.DBTX, p authz.Principal) ([]conversation.Readable, error) {
	if p.Role != "owner" {
		return conversation.SeatsOf(ctx, d, p.Identity())
	}
	list, err := conversation.ListAll(ctx, d)
	seats := make([]conversation.Readable, len(list))
	for i, cv := range list {
		seats[i] = conversation.Readable{Conversation: cv.ID}
	}
	return seats, err
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
