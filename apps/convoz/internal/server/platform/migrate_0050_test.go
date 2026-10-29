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

// Migration 0050 gives feed_items a plan_key: every row before it is the plan c<conversation>, the one-now rule is per (agent, plan).
func TestMigration0050_LegacyRowsBecomeThePlanOfTheirConversation(t *testing.T) {
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
	opts := platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: 49}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','dev','Dev','dev','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1),(11,1,1,1)`,
		`INSERT INTO feed_items (id, agent_id, conversation_id, work_key, seq, state, owner_step, title, version, created_at, updated_at) VALUES (1,2,10,'a',1,'started',0,'A',1,1,1),(2,2,11,'b',1,'started',0,'B',1,1,1)`,
		`INSERT INTO feed_item_events (item_id, version, event, to_state, at) VALUES (1,1,'start','started',1),(2,1,'start','started',1)`,
	)
	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	if count(t, s, "feed_items") != 2 || count(t, s, "feed_item_events") != 2 {
		t.Fatal("a row was lost")
	}
	var a, b string
	row := s.Reader.SQL().QueryRow(`SELECT (SELECT plan_key FROM feed_items WHERE id = 1), (SELECT plan_key FROM feed_items WHERE id = 2)`)
	if err := row.Scan(&a, &b); err != nil || a != "c10" || b != "c11" {
		t.Fatalf("plan keys %q %q: %v", a, b, err)
	}
	var ic string
	if err := s.Reader.SQL().QueryRow(`PRAGMA integrity_check`).Scan(&ic); err != nil || ic != "ok" {
		t.Fatalf("integrity_check %q %v", ic, err)
	}
	rows, err := s.Reader.SQL().Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign_key_check is not empty")
	}
	// A new row defaults to main; two started items of one agent in different plans are fine, in one plan they are not.
	dbtest.Exec(t, s, `INSERT INTO feed_items (id, agent_id, conversation_id, work_key, seq, state, owner_step, title, version, created_at, updated_at) VALUES (3,2,10,'c',2,'pending',0,'C',1,1,1)`)
	var def string
	if err := s.Reader.SQL().QueryRow(`SELECT plan_key FROM feed_items WHERE id = 3`).Scan(&def); err != nil || def != "main" {
		t.Fatalf("default %q %v", def, err)
	}
	if _, err := s.Writer.SQL().Exec(`UPDATE feed_items SET state = 'started', plan_key = 'c10' WHERE id = 3`); err == nil {
		t.Fatal("two started items in one plan were allowed")
	}
}
