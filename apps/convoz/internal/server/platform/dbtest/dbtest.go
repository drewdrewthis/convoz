// Package dbtest opens a migrated throwaway database for module tests. It holds no SQL of its own: each module
// seeds the rows it needs, so table ownership stays with the modules.
package dbtest

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Store is a database in the test's temp dir at the newest schema, closed when the test ends.
func Store(t testing.TB) *pdb.Store {
	t.Helper()
	key := append([]byte("TESTONLY"), make([]byte, 24)...)
	s, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := platform.Migrate(context.Background(), s, platform.MigrateOptions{DataDir: t.TempDir(), Clock: platform.SystemClock{}}); err != nil {
		t.Fatal(err)
	}
	return s
}

// Tx runs fn in one write transaction with a 30 s bound and fails the test on error.
func Tx(t testing.TB, s *pdb.Store, fn func(ctx context.Context, d pdb.DBTX) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error { return fn(ctx, tx.DBTX()) }); err != nil {
		t.Fatal(err)
	}
}

// Exec runs statements in one transaction; for seeding rows.
func Exec(t testing.TB, s *pdb.Store, statements ...string) {
	t.Helper()
	Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		for _, q := range statements {
			if _, err := d.ExecContext(ctx, q); err != nil {
				return err
			}
		}
		return nil
	})
}
