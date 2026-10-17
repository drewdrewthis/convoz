package message_test

import (
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// threadFakes adds the threads and mentions ports to the fakes: it records the replies it is told about.
type threadFakes struct {
	fakes
	replies   []message.Reply
	mentioned []int64
}

func (f *threadFakes) Replied(_ context.Context, _ pdb.DBTX, _ time.Time, r message.Reply) error {
	f.replies = append(f.replies, r)
	return nil
}

func (f *threadFakes) RecordMentions(context.Context, pdb.DBTX, time.Time, message.Message) ([]int64, error) {
	return f.mentioned, nil
}

func (f *threadFakes) ports() message.Ports {
	p := f.fakes.ports()
	p.Threads, p.Mentions = f, f
	return p
}

func postThread(t *testing.T, s *pdb.Store, f *threadFakes, d message.Draft) message.Posted {
	t.Helper()
	var p message.Posted
	dbtest.Tx(t, s, func(ctx context.Context, tx pdb.DBTX) (err error) {
		p, err = message.Post(ctx, tx, f.ports(), t0, d)
		return err
	})
	return p
}

func TestAReplyTellsTheThreadsPortWhoWroteTheRootWhereTheThreadStoodAndWhoIsMentioned(t *testing.T) {
	s := seeded(t)
	f := &threadFakes{mentioned: []int64{owner}}
	root := postThread(t, s, f, message.Draft{Conversation: conv, Author: devtool, ClientID: "client-root", Body: "step 1"}).Message
	if len(f.replies) != 0 {
		t.Fatal("a main message is not a reply")
	}
	first := postThread(t, s, f, message.Draft{Conversation: conv, Author: docs, ClientID: "client-r1", Body: "@drew look", ThreadRoot: root.ID}).Message
	second := postThread(t, s, f, message.Draft{Conversation: conv, Author: owner, ClientID: "client-r2", Body: "ok", ThreadRoot: root.ID, Broadcast: true}).Message

	want := []message.Reply{
		{Conversation: conv, Root: root.ID, RootAuthor: devtool, Author: docs, ID: first.ID, PrevLast: root.ID, Mentioned: []int64{owner}},
		{Conversation: conv, Root: root.ID, RootAuthor: devtool, Author: owner, ID: second.ID, PrevLast: first.ID, Mentioned: []int64{owner}},
	}
	if len(f.replies) != 2 {
		t.Fatalf("replies told: %d", len(f.replies))
	}
	for i, r := range f.replies {
		w := want[i]
		if r.Conversation != w.Conversation || r.Root != w.Root || r.RootAuthor != w.RootAuthor || r.Author != w.Author || r.ID != w.ID || r.PrevLast != w.PrevLast || len(r.Mentioned) != 1 {
			t.Errorf("reply %d: %+v, want %+v", i, r, w)
		}
	}
}

func TestThreadCountsLeaveOutOwnSystemDeletedAndBroadcastReplies(t *testing.T) {
	s := seeded(t)
	dbtest.Exec(t, s,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (20,10,2,'text','root',1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, broadcast, created_at) VALUES
		   (21,10,3,'text','a reply',20,0,2), (22,10,1,'text','mine',20,0,3), (23,10,3,'text','also in main',20,1,4)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, deleted_at, deleted_by, created_at) VALUES (24,10,3,'text','gone',20,5,3,5)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if n, err := message.CountThreadUnread(ctx, d, 20, 20, owner); err != nil || n != 1 {
			t.Errorf("unread replies %d err=%v: only the one reply by another that is neither a broadcast nor deleted counts", n, err)
		}
		if n, err := message.CountThreadUnread(ctx, d, 20, 21, owner); err != nil || n != 0 {
			t.Errorf("after the reply: %d err=%v", n, err)
		}
		if n, err := message.CountBroadcastRead(ctx, d, 20, 20, 23, owner); err != nil || n != 1 {
			t.Errorf("broadcasts read in the thread: %d err=%v", n, err)
		}
		if n, err := message.CountBroadcastRead(ctx, d, 20, 20, 22, owner); err != nil || n != 0 {
			t.Errorf("a broadcast beyond the thread position is not read: %d err=%v", n, err)
		}
		if prev, err := message.PrevReplyID(ctx, d, 20, 23); err != nil || prev != 22 {
			t.Errorf("the reply before 23 is 22: %d err=%v", prev, err)
		}
		if newest, err := message.NewestReplyID(ctx, d, 20); err != nil || newest != 24 {
			t.Errorf("newest reply %d err=%v", newest, err)
		}
		return nil
	})
}
