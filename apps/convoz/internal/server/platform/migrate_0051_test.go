package platform_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// Migration 0051 rebuilds inbox_items to allow the reason item_stale (with the feed item it is about); no row is lost.
func TestMigration0051_InboxItemsKeepTheirRowsAndAcceptAnItemStaleReminder(t *testing.T) {
	ctx := context.Background()
	s, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), append([]byte("TESTONLY"), make([]byte, 24)...))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "keyring.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: 50}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO feed_items (id, agent_id, conversation_id, work_key, seq, state, owner_step, title, version, created_at, updated_at) VALUES (1,2,10,'a',1,'started',0,'Step a',1,1,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (5,10,1,'text','hi',1)`,
		`INSERT INTO inbox_items (identity_id, reason, conversation_id, message_id, ask_message_id, count, mention_count, source_seq, state, acked_at, acked_by_watch, created_at, updated_at) VALUES
		 (2,'mention',10,5,NULL,1,1,1,'acked',3,1,1,1),
		 (2,'ask_resolved',10,5,5,1,0,2,'ready',NULL,0,1,1),
		 (2,'membership',10,NULL,NULL,1,0,3,'ready',NULL,0,1,1),
		 (2,'app_result',10,5,NULL,1,0,4,'ready',NULL,0,1,1),
		 (2,'status_due',10,NULL,NULL,1,0,7,'ready',NULL,0,1,1),
		 (2,'unanswered',10,5,NULL,1,0,0,'ready',NULL,0,1,1)`,
	)
	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	if count(t, s, "inbox_items") != 6 {
		t.Fatal("a row was lost")
	}
	var watched, reasons int
	if err := s.Reader.SQL().QueryRow("SELECT sum(acked_by_watch), count(DISTINCT reason) FROM inbox_items").Scan(&watched, &reasons); err != nil {
		t.Fatal(err)
	}
	if watched != 1 || reasons != 6 {
		t.Errorf("acked_by_watch rows %d (want 1), reasons %d (want 6)", watched, reasons)
	}
	rows, err := s.Reader.SQL().Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign_key_check is not empty after the migration")
	}
	dbtest.Exec(t, s, `INSERT INTO inbox_items (identity_id, reason, conversation_id, feed_item_id, count, mention_count, source_seq, state, created_at, updated_at) VALUES (2,'item_stale',10,1,1,0,0,'ready',2,2)`)
	if count(t, s, "inbox_items") != 7 {
		t.Fatal("the item_stale insert did not land")
	}
}
