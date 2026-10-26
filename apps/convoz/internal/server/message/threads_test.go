package message_test

import (
	"context"
	"reflect"
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
		if got, err := message.CountThreadsUnread(ctx, d, []message.ReadPoint{{Root: 20, After: 20}, {Root: 99, After: 0}}, owner); err != nil || len(got) != 1 || got[20] != 1 {
			t.Errorf("grouped unread %v err=%v: the same count as one thread alone, and a thread with none is absent", got, err)
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

func TestInThreadAndRepliesAnsweredWorkWithAnyNumberOfIDs(t *testing.T) {
	s := seeded(t)
	dbtest.Exec(t, s,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (20,10,2,'text','root',1),(30,10,1,'text','main',1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES
		   (21,10,3,'text','a reply',20,2), (22,10,1,'text','owner answers',20,3), (23,10,1,'text','owner again, nobody answers',20,4)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		for _, c := range []struct {
			name string
			ids  []int64
			want []int64
		}{
			{"one reply", []int64{21}, []int64{21}},
			{"one message outside the thread", []int64{30}, nil},
			{"three ids: the root, a reply, a main message", []int64{30, 20, 21}, []int64{21}},
			{"three replies", []int64{23, 21, 22}, []int64{21, 22, 23}},
		} {
			got, err := message.InThread(ctx, d, 20, c.ids)
			if err != nil || !reflect.DeepEqual(got, c.want) {
				t.Errorf("InThread %s: %v err=%v, want %v", c.name, got, err, c.want)
			}
		}
		if got, err := message.RepliesAnswered(ctx, d, []int64{21, 22, 23}); err != nil || !reflect.DeepEqual(got, []int64{21}) {
			t.Errorf("answered replies %v err=%v: only 21 has a later reply by someone else (22); 22 and 23 have none", got, err)
		}
		return nil
	})
}

// Owner, conv 179 msg 6018: the server counts the unread @mentions, under the same read points as the unread count.
func TestUnreadMentionsCountOnlyUnreadMentionsOfTheReaderByOthers(t *testing.T) {
	s := seeded(t)
	dbtest.Exec(t, s,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES
		   (20,10,1,'text','root',1), (21,10,2,'text','@drew look',2), (22,10,2,'text','@devtool plain',3), (25,10,1,'text','@drew me',6)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, broadcast, created_at) VALUES
		   (23,10,3,'text','@drew see',20,0,4), (24,10,3,'text','@drew also in main',20,1,5)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, deleted_at, deleted_by, created_at) VALUES (26,10,2,'text','@drew gone',7,2,7)`,
		`INSERT INTO mentions (message_id, identity_id) VALUES (21,1),(22,2),(23,1),(24,1),(25,1),(26,1)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		for _, c := range []struct {
			name      string
			mainAfter int64
			points    []message.ReadPoint
			want      int64
		}{
			{"main mention, broadcast mention and thread mention; not its own, not deleted, not another's", 20, []message.ReadPoint{{Root: 20, After: 20}}, 3},
			{"read past them all, the broadcast in its thread", 22, []message.ReadPoint{{Root: 20, After: 24}}, 0},
			{"a thread the reader is not in does not count", 20, nil, 2},
		} {
			if n, err := message.CountUnreadMentions(ctx, d, conv, owner, c.mainAfter, c.points); err != nil || n != c.want {
				t.Errorf("%s: %d err=%v, want %d", c.name, n, err, c.want)
			}
		}
		for at, want := range map[int64]int64{19: 0, 20: owner, 22: devtool, 23: devtool, 24: docs} {
			if got, err := message.MainAuthorAt(ctx, d, conv, at); err != nil || got != want {
				t.Errorf("main author at %d: %d err=%v, want %d (a thread-only reply is not in the main list)", at, got, err, want)
			}
		}
		return nil
	})
}
