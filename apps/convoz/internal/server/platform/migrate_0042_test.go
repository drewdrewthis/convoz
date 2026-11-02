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

// Migration 0042 gives bit 32 (once "pickup") to "page": no old grant may come out of it as page access.
func TestMigration0042ClearsTheOldPickupBit(t *testing.T) {
	ctx := context.Background()
	key := append([]byte("TESTONLY"), make([]byte, 24)...)
	s, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	// a migration on a database with rows first backs it up with the keyring, so the data dir needs one
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "keyring.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	migrate := func(max int) {
		t.Helper()
		if err := platform.Migrate(ctx, s, platform.MigrateOptions{DataDir: data, Clock: platform.SystemClock{}, MaxVersion: max}); err != nil {
			t.Fatal(err)
		}
	}
	migrate(41)
	// machine 1: default scopes plus pickup; machine 2: pickup only; machine 3: no pickup. One lease of each.
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO machines (id, name, key_hash, key_enc, key_dek_id, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at) VALUES
		   (1,'box-1',randomblob(32),zeroblob(8),1,'cvz_m_x',63,'any',1,1,1),
		   (2,'box-2',randomblob(32),zeroblob(8),1,'cvz_m_x',32,'any',1,1,1),
		   (3,'box-3',randomblob(32),zeroblob(8),1,'cvz_m_x',31,'any',1,1,1)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (100,2,1,randomblob(32),'client-aaaa','a',63,1,1,9999999999999),
		   (101,2,2,randomblob(32),'client-bbbb','b',32,1,1,9999999999999),
		   (102,2,3,randomblob(32),'client-cccc','c',31,1,1,9999999999999)`)
	migrate(0)

	// pickup is cleared; a pickup-only row gets read (1), never page (32)
	want := map[int64]int64{1: 31, 2: 1, 3: 31}
	for _, table := range []struct {
		name string
		ids  map[int64]int64
	}{{"machines", want}, {"sessions", map[int64]int64{100: 31, 101: 1, 102: 31}}} {
		for id, scopes := range table.ids {
			var got int64
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				return d.QueryRowContext(ctx, "SELECT scopes FROM "+table.name+" WHERE id = ?", id).Scan(&got)
			})
			if got != scopes {
				t.Errorf("%s %d: scopes %d, want %d", table.name, id, got, scopes)
			}
		}
	}
}
