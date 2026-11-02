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

func count(t *testing.T, s *pdb.Store, table string) int {
	t.Helper()
	var n int
	if err := s.Reader.SQL().QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Migration 0044 rebuilds uploads and transcripts to lift the voice note limit to 30 minutes; no row may be lost or left pointing nowhere.
func TestMigration0044_UploadsAndTranscriptsKeepTheirRowsAndReferences(t *testing.T) {
	ctx := context.Background()
	s, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), append([]byte("TESTONLY"), make([]byte, 24)...))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	dataDir := t.TempDir() // migrating a database that holds data backs it up with the keyring first
	if err := os.WriteFile(filepath.Join(dataDir, "keyring.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: 43}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	sha := "x'" + "00000000000000000000000000000000000000000000000000000000000000" + "00'"
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO uploads (id, public_id, uploader_id, conversation_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed, filename, storage_name, dek_id, file_key_wrapped, duration_ms, created_at, completed_at)
		 VALUES (1,'aaaaaaaaaaaaaaaaaaaaaa',1,10,'audio','complete',100,100,`+sha+`,'audio/webm','a.webm','s1',1,x'01',299999,1,1)`,
		`INSERT INTO uploads (id, public_id, uploader_id, conversation_id, kind, state, declared_size, committed_bytes, declared_sha256, filename, storage_name, dek_id, file_key_wrapped, created_at)
		 VALUES (2,'bbbbbbbbbbbbbbbbbbbbbb',1,10,'file','receiving',100,0,`+sha+`,'b.txt','s2',1,x'01',1)`,
		`INSERT INTO transcripts (upload_id, state, text, updated_at) VALUES (1,'done','hello',1)`,
	)
	uploads, transcripts := count(t, s, "uploads"), count(t, s, "transcripts")
	if uploads != 2 || transcripts != 1 {
		t.Fatalf("seed: %d uploads, %d transcripts", uploads, transcripts)
	}

	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	if n := count(t, s, "uploads"); n != uploads {
		t.Errorf("uploads: %d rows after, %d before", n, uploads)
	}
	if n := count(t, s, "transcripts"); n != transcripts {
		t.Errorf("transcripts: %d rows after, %d before", n, transcripts)
	}
	rows, err := s.Reader.SQL().Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("foreign_key_check is not empty after the migration")
	}
	// The point of the migration: a 30 minute note fits, a longer one does not.
	dbtest.Exec(t, s, `UPDATE uploads SET duration_ms = 1800000 WHERE id = 1`)
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := d.ExecContext(ctx, `UPDATE uploads SET duration_ms = 1800001 WHERE id = 1`)
		return err
	}); err == nil {
		t.Error("a duration over 30 minutes was accepted")
	}
}
