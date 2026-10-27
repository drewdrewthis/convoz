package httpapi

// Issue 103: "Later" on a mention card hides it until its time; a new mention after the Later shows it at once.

import (
	"context"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
)

// laterStore has conversation 10 with one unread mention of the owner (message 100).
func laterStore(t *testing.T) *pdb.Store {
	s := mentionStore(t)
	dbtest.Exec(t, s,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (100,10,2,'text','@drew look',1)`,
		`INSERT INTO mentions (message_id, identity_id) VALUES (100,1)`,
		`INSERT INTO read_cursors (identity_id, conversation_id, last_read_main_id, thread_floor_id, updated_at) VALUES (1,10,99,99,1)`,
		lastMainFixup)
	return s
}

// mentionsAt is what the owner is told about conversation 10 at now: the Now badge count, and the row's mention count and Later.
func mentionsAt(t *testing.T, s *pdb.Store, now time.Time) (badge int, row, until int64) {
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		if badge, err = mentionedConversations(ctx, d, ownerCaller, now); err != nil {
			return err
		}
		cv, _, err := conversation.Get(ctx, d, 10)
		if err != nil {
			return err
		}
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		v, err := conversationView(ctx, d, ownerCaller, dir, cv, 0, now)
		row, until = v.UnreadMentions, v.MentionSnoozedUntil
		return err
	})
	return badge, row, until
}

func snoozeFor(t *testing.T, s *pdb.Store, d time.Duration) {
	dbtest.Tx(t, s, func(ctx context.Context, db pdb.DBTX) error {
		return prefs.SnoozeMentions(ctx, db, mOwner, 10, mentionNow.Add(d).UnixMilli(), 100)
	})
}

func TestLaterHidesAMentionUntilItsTime(t *testing.T) {
	s := laterStore(t)
	if badge, row, until := mentionsAt(t, s, mentionNow); badge != 1 || row != 1 || until != 0 {
		t.Fatalf("before Later: badge %d, row %d, until %d; want 1, 1, 0", badge, row, until)
	}
	snoozeFor(t, s, time.Hour)
	if badge, row, until := mentionsAt(t, s, mentionNow); badge != 0 || row != 0 || until != mentionNow.Add(time.Hour).UnixMilli() {
		t.Errorf("during Later: badge %d, row %d, until %d; want 0, 0, the end of the hour", badge, row, until)
	}
}

func TestLaterEndsAtItsTime(t *testing.T) {
	s := laterStore(t)
	snoozeFor(t, s, time.Hour)
	if badge, row, until := mentionsAt(t, s, mentionNow.Add(time.Hour+time.Minute)); badge != 1 || row != 1 || until != 0 {
		t.Errorf("after Later: badge %d, row %d, until %d; want 1, 1, 0", badge, row, until)
	}
}

func TestANewMentionBringsTheCardBackAtOnce(t *testing.T) {
	s := laterStore(t)
	snoozeFor(t, s, time.Hour)
	dbtest.Exec(t, s,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (101,10,2,'text','@drew still there?',2)`,
		`INSERT INTO mentions (message_id, identity_id) VALUES (101,1)`,
		lastMainFixup)
	if badge, row, _ := mentionsAt(t, s, mentionNow); badge != 1 || row != 1 {
		t.Errorf("after a new mention during Later: badge %d, row %d; want 1, 1 (only the new one)", badge, row)
	}
}

func TestLaterIsPerPerson(t *testing.T) {
	s := laterStore(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := prefs.SnoozeMentions(ctx, d, mMember, 10, mentionNow.Add(time.Hour).UnixMilli(), 100); err != nil {
			return err
		}
		got, err := prefs.MentionSnoozes(ctx, d, mOwner, mentionNow)
		if len(got) != 0 {
			t.Errorf("the owner's Laters = %v; want none (Mia's does not count)", got)
		}
		return err
	})
}
