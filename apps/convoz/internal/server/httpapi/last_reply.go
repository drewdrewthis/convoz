package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// lastReplyOf is the newest reply of a thread root as the reader sees it under the root's reply chip: who, a short plain-text
// preview and when. Unread is set when the reply is someone else's, in a thread the reader is involved in (DA-3), and past the
// reader's read point there. It is nil when the root has no reply that still reads.
func lastReplyOf(ctx context.Context, d pdb.DBTX, dir directory, p authz.Principal, conv, root int64) (*wire.LastReply, error) {
	r, ok, err := message.NewestReply(ctx, d, root)
	if err != nil || !ok {
		return nil, err
	}
	out := &wire.LastReply{ID: r.ID, Author: dir.person(r.AuthorID), Preview: message.ReplyPreview(r.Body), CreatedAt: r.CreatedAt}
	reader := p.Identity()
	if r.AuthorID == reader {
		return out, nil
	}
	threads, err := readstate.Threads(ctx, d, reader, conv)
	if err != nil {
		return nil, err
	}
	for _, t := range threads {
		if t.Root != root {
			continue
		}
		floor, err := readstate.Floor(ctx, d, reader, conv)
		if err != nil {
			return nil, err
		}
		out.Unread = r.ID > max(t.LastRead, floor)
	}
	return out, nil
}

// unreadRepliesOf counts, in one query, the replies the reader has not read in each of the given thread roots of a conversation,
// by root. Only a thread the reader is involved in counts (DA-3), and the reader's own replies never do. Roots with none are absent.
func unreadRepliesOf(ctx context.Context, d pdb.DBTX, reader, conv int64, roots []int64) (map[int64]int64, error) {
	if len(roots) == 0 {
		return nil, nil
	}
	threads, err := readstate.Threads(ctx, d, reader, conv)
	if err != nil || len(threads) == 0 {
		return nil, err
	}
	floor, err := readstate.Floor(ctx, d, reader, conv)
	if err != nil {
		return nil, err
	}
	wanted := make(map[int64]bool, len(roots))
	for _, r := range roots {
		wanted[r] = true
	}
	var points []message.ReadPoint
	for _, t := range threads {
		if wanted[t.Root] {
			points = append(points, message.ReadPoint{Root: t.Root, After: max(t.LastRead, floor)})
		}
	}
	return message.CountThreadsUnread(ctx, d, points, reader)
}

// attachLastReplies sets last_reply and unread_replies on each thread root of a page.
func attachLastReplies(ctx context.Context, d pdb.DBTX, dir directory, p authz.Principal, conv int64, msgs []*wire.Message) error {
	var roots []int64
	for _, m := range msgs {
		if isReplyRoot(m) {
			roots = append(roots, m.ID)
		}
	}
	unread, err := unreadRepliesOf(ctx, d, p.Identity(), conv, roots)
	if err != nil {
		return err
	}
	for _, m := range msgs {
		if !isReplyRoot(m) {
			continue
		}
		m.UnreadReplies = unread[m.ID]
		lr, err := lastReplyOf(ctx, d, dir, p, conv, m.ID)
		if err != nil {
			return err
		}
		m.LastReply = lr
	}
	return nil
}

// attachLastRepliesSlice is attachLastReplies for a page.
func attachLastRepliesSlice(ctx context.Context, d pdb.DBTX, dir directory, p authz.Principal, conv int64, page []wire.Message) error {
	ptrs := make([]*wire.Message, len(page))
	for i := range page {
		ptrs[i] = &page[i]
	}
	return attachLastReplies(ctx, d, dir, p, conv, ptrs)
}

func isReplyRoot(m *wire.Message) bool { return m.ReplyCount > 0 && !m.Deleted && m.ThreadRootID == 0 }
