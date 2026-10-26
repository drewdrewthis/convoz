package httpapi

// Advisor, conv 331 msg 6191 / issue 105: Now counts mentions in one query, not per chat.

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
)

const (
	mOwner  = 1
	mAgent  = 2
	mAgent2 = 3
	mMember = 4
)

var (
	mentionNow   = time.UnixMilli(1_000_000)
	ownerCaller  = authz.Principal{Authenticated: true, HumanID: mOwner, Role: "owner"}
	memberCaller = authz.Principal{Authenticated: true, HumanID: mMember, Role: "member"}
)

// countingDB counts every statement sent to the database.
type countingDB struct {
	pdb.DBTX
	n int
}

func (c *countingDB) ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error) {
	c.n++
	return c.DBTX.ExecContext(ctx, q, args...)
}

func (c *countingDB) PrepareContext(ctx context.Context, q string) (*sql.Stmt, error) {
	c.n++
	return c.DBTX.PrepareContext(ctx, q)
}

func (c *countingDB) QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	c.n++
	return c.DBTX.QueryContext(ctx, q, args...)
}

func (c *countingDB) QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row {
	c.n++
	return c.DBTX.QueryRowContext(ctx, q, args...)
}

// oldMentionCount is the per-chat loop Now used before issue 105: the reference the one-query count must equal.
func oldMentionCount(ctx context.Context, d pdb.DBTX, p authz.Principal, now time.Time) (int, error) {
	var list []conversation.Conversation
	var err error
	if p.Role == "owner" {
		list, err = conversation.ListAll(ctx, d)
	} else {
		list, err = conversation.ListOf(ctx, d, p.Identity())
	}
	if err != nil {
		return 0, err
	}
	pf, err := prefs.All(ctx, d, p.Identity())
	if err != nil {
		return 0, err
	}
	count := 0
	for _, cv := range list {
		if pf[cv.ID].MutedUntil > now.UnixMilli() {
			continue
		}
		floor, ok, err := canRead(ctx, d, p, cv.ID)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		u, err := unreadParts(ctx, d, p.Identity(), cv, floor)
		if err != nil {
			return 0, err
		}
		n, err := unreadMentions(ctx, d, p.Identity(), cv, u)
		if err != nil {
			return 0, err
		}
		if n > 0 {
			count++
		}
	}
	return count, nil
}

// mentionStore has the owner, two agents and a member, and no conversation yet.
func mentionStore(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1),
		   (3,'agent','docs','Docs','docs','D',0,1),(4,'human','mia','Mia','mia','M',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap'),(4,'member','invite')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`)
	return s
}

// lastMainFixup sets last_main_id as posting would: the seeds insert messages directly.
const lastMainFixup = `UPDATE conversations SET last_main_id = COALESCE((SELECT MAX(id) FROM messages m WHERE m.conversation_id = conversations.id AND m.in_main = 1), 0)`

// seedTimingRun builds n conversations like the issue 105 timing run: each has one unread agent message, in every 5th it
// @mentions the owner, and in every 10th the owner wrote first.
func seedTimingRun(t *testing.T, s *pdb.Store, n int) {
	var convs, msgs, mentions, cursors []string
	id := 0
	for i := 1; i <= n; i++ {
		conv := 1000 + i
		convs = append(convs, fmt.Sprintf("(%d,1,%d,%d)", conv, i, i))
		read := 0
		if i%10 == 0 {
			id++
			msgs = append(msgs, fmt.Sprintf("(%d,%d,1,'text','first',%d)", id, conv, i))
			read = id
		}
		id++
		body := "an update"
		if i%5 == 0 {
			body = "@drew an update"
			mentions = append(mentions, fmt.Sprintf("(%d,1)", id))
		}
		msgs = append(msgs, fmt.Sprintf("(%d,%d,2,'text','%s',%d)", id, conv, body, i))
		cursors = append(cursors, fmt.Sprintf("(1,%d,%d,%d,1)", conv, read, read))
	}
	stmts := []string{
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES ` + strings.Join(convs, ","),
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES ` + strings.Join(msgs, ","),
		`INSERT INTO read_cursors (identity_id, conversation_id, last_read_main_id, thread_floor_id, updated_at) VALUES ` + strings.Join(cursors, ","),
	}
	if len(mentions) > 0 {
		stmts = append(stmts, `INSERT INTO mentions (message_id, identity_id) VALUES `+strings.Join(mentions, ","))
	}
	dbtest.Exec(t, s, append(stmts, lastMainFixup)...)
}

// queriesFor runs mentionedConversations for the owner over n timing-run conversations and returns the statements it sent.
func queriesFor(t *testing.T, n int) (queries, count int) {
	s := mentionStore(t)
	seedTimingRun(t, s, n)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		c := &countingDB{DBTX: d}
		got, err := mentionedConversations(ctx, c, ownerCaller, mentionNow)
		queries, count = c.n, got
		return err
	})
	return queries, count
}

func TestNowMentionsCountUsesAFixedNumberOfQueries(t *testing.T) {
	q2, _ := queriesFor(t, 2)
	q50, _ := queriesFor(t, 50)
	q200, _ := queriesFor(t, 200)
	if q2 != q50 || q2 != q200 || q2 > 5 {
		t.Errorf("queries for 2, 50 and 200 conversations: %d, %d, %d; want the same number, at most 5", q2, q50, q200)
	}
}

func TestNowMentionsCountAtTwoHundredConversationsMatchesThePerChatLoop(t *testing.T) {
	s := mentionStore(t)
	seedTimingRun(t, s, 200)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		got, err := mentionedConversations(ctx, d, ownerCaller, mentionNow)
		if err != nil {
			return err
		}
		old, err := oldMentionCount(ctx, d, ownerCaller, mentionNow)
		if err != nil {
			return err
		}
		if got != 40 || old != 40 {
			t.Errorf("mentions = %d, per-chat loop = %d; want 40 (every 5th of 200)", got, old)
		}
		return nil
	})
}

// seedMentionCases builds one conversation per rule of the mention count. The comment on each says whether it counts for
// the owner; the member (Mia) sees only the conversations she is an active participant of, from her join floor.
func seedMentionCases(t *testing.T, s *pdb.Store) {
	var many []string
	// c22: over 100 unread, the only mention is the oldest. c23: over 100 unread, the only mention is the newest.
	for i := 0; i < 120; i++ {
		many = append(many, fmt.Sprintf("(%d,22,2,'text','more',1)", 2201+i), fmt.Sprintf("(%d,23,2,'text','more',1)", 2500+i))
	}
	dbtest.Exec(t, s,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES
		   (10,1,1,1),(11,1,1,1),(12,1,1,1),(13,1,1,1),(14,1,1,1),(15,1,1,1),(16,1,1,1),(17,1,1,1),(18,1,1,1),
		   (20,1,1,1),(21,1,1,1),(22,1,1,1),(23,1,1,1),(24,1,1,1),(25,1,1,1),(30,1,1,1),(31,1,1,1),(32,1,1,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at, deleted_at, deleted_by) VALUES (19,1,1,1,5,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES
		   (100,10,2,'text','@drew unread main mention',1),
		   (110,11,2,'text','@drew read main mention',1),
		   (120,12,1,'text','root',1),
		   (130,13,1,'text','root',1),
		   (140,14,2,'text','root',1),
		   (150,15,1,'text','@drew my own',1),
		   (180,18,2,'text','@drew muted',1),
		   (190,19,2,'text','@drew trashed',1),
		   (200,20,2,'text','@drew no cursor',1),
		   (210,21,1,'text','root',1),
		   (2200,22,2,'text','@drew old',1),
		   (2620,23,2,'text','@drew new',1),
		   (240,24,2,'text','@drew mute ran out',1),
		   (250,25,2,'text','@devtool not the reader',1),
		   (300,30,2,'text','@mia unread',1),
		   (310,31,2,'text','@mia before she joined',1),
		   (320,32,2,'text','@mia after she left',1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES `+strings.Join(many, ","),
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, thread_root_id, broadcast, created_at) VALUES
		   (121,12,2,'text','@drew also in main, read in its thread',120,1,1),
		   (131,13,2,'text','@drew in a thread I am in',130,0,1),
		   (141,14,3,'text','@drew in a thread I am not in',140,0,1),
		   (211,21,2,'text','@drew under the mark-all-read floor',210,0,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, deleted_at, deleted_by, created_at) VALUES (160,16,2,'text','@drew gone',2,2,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, system_json, created_at) VALUES (170,17,NULL,'system','{}',1)`,
		`INSERT INTO mentions (message_id, identity_id) VALUES
		   (100,1),(110,1),(121,1),(131,1),(141,1),(150,1),(160,1),(170,1),(180,1),(190,1),(200,1),(211,1),(2200,1),(2620,1),(240,1),
		   (250,2),(131,4),(300,4),(310,4),(320,4)`,
		`INSERT INTO read_cursors (identity_id, conversation_id, last_read_main_id, thread_floor_id, updated_at) VALUES
		   (1,10,99,99,1),   -- counts
		   (1,11,110,110,1), -- read
		   (1,12,120,120,1), -- the broadcast reply was read in the thread
		   (1,13,130,130,1), -- counts: a reply in a thread the owner is in
		   (1,14,140,140,1), -- a thread the owner is not in
		   (1,15,149,149,1), -- own mention
		   (1,16,159,159,1), -- deleted
		   (1,17,169,169,1), -- system
		   (1,18,179,179,1), -- muted
		   (1,19,189,189,1), -- in the trash
		   (1,21,210,211,1), -- mark all read put the thread floor past the reply
		   (1,22,2199,2199,1), -- counts
		   (1,23,2499,2499,1), -- counts
		   (1,24,239,239,1), -- counts: the mute ran out
		   (1,25,249,249,1), -- mentions another
		   (4,13,0,0,1),     -- Mia has a cursor but no seat in 13
		   (4,30,299,299,1), -- counts for Mia
		   (4,31,0,0,1),     -- below her join floor
		   (4,32,319,319,1)  -- she left`,
		`INSERT INTO thread_reads (identity_id, conversation_id, root_id, last_read_id, involved_at) VALUES
		   (1,12,120,121,1),(1,13,130,130,1),(1,21,210,210,1),(4,13,130,0,1)`,
		`INSERT INTO conversation_prefs (identity_id, conversation_id, muted_until, updated_at) VALUES (1,18,253402300799000,1),(1,24,5,1)`,
		`INSERT INTO participants (conversation_id, identity_id, status, joined_message_id, added_by, added_at, status_at) VALUES
		   (10,4,'active',0,1,1,1),(30,4,'active',0,1,1,1),(31,4,'active',311,1,1,1),(32,4,'left',0,1,1,1)`,
		lastMainFixup)
}

func TestNowMentionsCountMatchesThePerChatLoopForEveryRule(t *testing.T) {
	s := mentionStore(t)
	seedMentionCases(t, s)
	for name, c := range map[string]struct {
		p    authz.Principal
		want int
	}{
		"the owner: 10, 13, 22, 23 and 24": {ownerCaller, 5},
		"a member: only 30":                {memberCaller, 1},
	} {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			got, err := mentionedConversations(ctx, d, c.p, mentionNow)
			if err != nil {
				return err
			}
			old, err := oldMentionCount(ctx, d, c.p, mentionNow)
			if err != nil {
				return err
			}
			if got != c.want || old != c.want {
				t.Errorf("%s: mentions = %d, per-chat loop = %d, want %d", name, got, old, c.want)
			}
			return nil
		})
	}
}
