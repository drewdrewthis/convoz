package httpapi

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
)

// Owner: Now shows a stale ask for a day, never a muted or staled chat; convoz waiting keeps the whole list for triage agents.

func TestAnOwnerMessageOlderThanADayLeavesNowButStaysInWaiting(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(24*time.Hour - time.Minute)
	if now, _ := r.unanswered(t); len(now) != 1 {
		t.Fatalf("23h59m old: %d in /api/now, want 1", len(now))
	}
	r.clock.add(2 * time.Minute)
	now, waiting := r.unanswered(t)
	if len(now) != 0 || len(waiting) != 1 {
		t.Fatalf("24h01m old: /api/now %d, /api/waiting %d, want 0 and 1", len(now), len(waiting))
	}
}

func TestAStaledConversationLeavesNowButStaysInWaiting(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(11 * time.Minute)
	dbtest.Exec(t, r.s.Store, `UPDATE conversations SET stale_at = last_activity_at WHERE id = `+strconv.FormatInt(r.conv, 10))
	now, waiting := r.unanswered(t)
	if len(now) != 0 || len(waiting) != 1 {
		t.Fatalf("staled: /api/now %d, /api/waiting %d, want 0 and 1", len(now), len(waiting))
	}
}

func TestAMutedConversationLeavesNowButStaysInWaiting(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(11 * time.Minute)
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		return prefs.SetMuted(ctx, d, r.clock.Now(), r.owner, r.conv, r.clock.Now().Add(time.Hour).UnixMilli())
	})
	now, waiting := r.unanswered(t)
	if len(now) != 0 || len(waiting) != 1 {
		t.Fatalf("muted: /api/now %d, /api/waiting %d, want 0 and 1", len(now), len(waiting))
	}
}

// threadReply inserts a thread reply under the owner's newest message by author.
func (r *freshRig) threadReply(t *testing.T, author int64) {
	t.Helper()
	dbtest.Exec(t, r.s.Store, `INSERT INTO messages (conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES (`+strconv.FormatInt(r.conv, 10)+`,`+strconv.FormatInt(author, 10)+`,'text','on it',(SELECT MAX(id) FROM messages WHERE conversation_id=`+strconv.FormatInt(r.conv, 10)+` AND thread_root_id IS NULL),`+strconv.FormatInt(r.clock.Now().UnixMilli(), 10)+`)`)
}

func TestAnAgentThreadReplyAnswersTheOwnerMessageInNowAndWaiting(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(time.Minute)
	r.threadReply(t, 901)
	r.clock.add(11 * time.Minute)
	if now, waiting := r.unanswered(t); len(now) != 0 || len(waiting) != 0 {
		t.Fatalf("after a thread reply: /api/now %d, /api/waiting %d, want 0 and 0", len(now), len(waiting))
	}
}

func TestTheOwnersReplyInHisOwnThreadDoesNotAnswerIt(t *testing.T) {
	r := newFreshRig(t)
	r.ownerSays(t)
	r.clock.add(time.Minute)
	r.threadReply(t, r.owner)
	r.clock.add(11 * time.Minute)
	if now, waiting := r.unanswered(t); len(now) != 1 || len(waiting) != 1 {
		t.Fatalf("owner thread reply: /api/now %d, /api/waiting %d, want 1 and 1", len(now), len(waiting))
	}
}

// 200 chats whose owner message is old enough: reports how long GET /api/now takes with the filters and per-chat reads.
func TestNowWithTwoHundredChatsReportsItsTime(t *testing.T) {
	r := newFreshRig(t)
	at := r.clock.Now().Add(-time.Hour).UnixMilli()
	var convs, msgs []string
	for i := 1000; i < 1200; i++ {
		id := strconv.Itoa(i)
		convs = append(convs, "("+id+","+strconv.FormatInt(r.owner, 10)+",1,"+strconv.FormatInt(at, 10)+")")
		msgs = append(msgs, "("+id+","+strconv.FormatInt(r.owner, 10)+",'text','hi',"+strconv.FormatInt(at, 10)+")")
	}
	dbtest.Exec(t, r.s.Store,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES `+strings.Join(convs, ","),
		`INSERT INTO messages (conversation_id, author_id, kind, body, created_at) VALUES `+strings.Join(msgs, ","))
	start := time.Now()
	now, _ := r.unanswered(t)
	t.Logf("GET /api/now with 201 chats: %d unanswered in %s", len(now), time.Since(start))
	if len(now) != conversation.MaxListed-1 { // ListAll reads at most MaxListed chats, the rig's own chat among them
		t.Errorf("%d unanswered, want %d", len(now), conversation.MaxListed-1)
	}
}
