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

// Migration 0049 rebuilds feed_items and feed_item_events to let the owner's Okay (got_it) stand on any state; no row is lost.
func TestMigration0049_FeedItemsKeepTheirRowsAndAcceptAnAckOnAStartedItem(t *testing.T) {
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
	opts := platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: 48}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO feed_items (id, agent_id, conversation_id, work_key, seq, state, owner_step, title, version, created_at, updated_at) VALUES (1,2,10,'a',1,'started',0,'Step a',1,1,1)`,
		`INSERT INTO feed_item_events (item_id, version, event, to_state, at) VALUES (1,1,'start','started',1)`,
	)
	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	if count(t, s, "feed_items") != 1 || count(t, s, "feed_item_events") != 1 {
		t.Fatal("a row was lost")
	}
	rows, err := s.Reader.SQL().Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign_key_check is not empty after the migration")
	}
	dbtest.Exec(t, s, `UPDATE feed_items SET acked_at = 5, acked_by = 1, ack_kind = 'got_it' WHERE id = 1`)
}
