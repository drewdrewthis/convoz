package platform_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// indexesOf lists the indexes of the push tables by name, so the rebuild can be checked to keep every one.
func indexesOf(t *testing.T, s *pdb.Store) []string {
	t.Helper()
	rows, err := s.Reader.SQL().Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('notifications','push_deliveries','push_subscriptions') AND sql IS NOT NULL ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

// Migration 0052 (owner, conv 179 msg 14826: news goes to the phone as a push, not a toast): a push subscription says whether its
// device takes a push for every message, and notifications are rebuilt to allow the reasons message and identity_request. No row is lost.
func TestMigration0052_PushTablesKeepTheirRowsAndAcceptMessagePushes(t *testing.T) {
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
	opts := platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: 51}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO devices (id, human_id, token_hash, label, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (7,1,zeroblob(32),'phone',1,1,9,9)`,
		`INSERT INTO push_subscriptions (id, device_id, identity_id, endpoint, p256dh, auth, created_at) VALUES (3,7,1,'https://web.push.apple.com/x',zeroblob(65),zeroblob(16),1)`,
		`INSERT INTO notifications (id, identity_id, reason, source_seq, topic, urgent, decision, suppressed_reason, created_at) VALUES
		 (1,1,'mention',1,'t1',0,'send',NULL,1),(2,1,'plan_waiting',2,'t2',0,'suppressed','muted',1)`,
		`INSERT INTO push_deliveries (notification_id, subscription_id, attempt, status, created_at, updated_at) VALUES (1,3,1,'sent',1,1)`,
	)
	before := indexesOf(t, s)
	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	if count(t, s, "notifications") != 2 || count(t, s, "push_deliveries") != 1 || count(t, s, "push_subscriptions") != 1 {
		t.Fatal("a row was lost")
	}
	var messages int
	if err := s.Reader.SQL().QueryRow("SELECT messages FROM push_subscriptions WHERE id = 3").Scan(&messages); err != nil || messages != 0 {
		t.Errorf("an existing subscription takes no plain-message push until its device says so: %d %v", messages, err)
	}
	if after := indexesOf(t, s); !slices.Equal(before, after) {
		t.Errorf("indexes before %v, after %v", before, after)
	}
	rows, err := s.Reader.SQL().Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign_key_check is not empty after the migration")
	}
	dbtest.Exec(t, s,
		`INSERT INTO notifications (identity_id, reason, source_seq, topic, urgent, decision, created_at) VALUES (1,'message',3,'t3',0,'send',2),(1,'identity_request',4,'t4',0,'send',2)`,
		`UPDATE push_subscriptions SET messages = 1 WHERE id = 3`,
	)
	if count(t, s, "notifications") != 4 {
		t.Fatal("the new reasons did not land")
	}
}
