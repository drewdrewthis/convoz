package platform

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		num, _, _ := strings.Cut(e.Name(), "_")
		v, err := strconv.Atoi(num)
		if err != nil {
			return nil, fmt.Errorf("migration %s: name must start with a number", e.Name())
		}
		body, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, migration{v, string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// LatestVersion is the newest schema version this build supports.
func LatestVersion() int {
	ms, err := loadMigrations()
	if err != nil || len(ms) == 0 {
		return 0
	}
	return ms[len(ms)-1].version
}

// NewerSchemaError means the data dir was migrated by a newer build (exit 11).
type NewerSchemaError struct{ Found, Supported int }

func (e *NewerSchemaError) Error() string {
	return fmt.Sprintf("data dir schema version %d is newer than this build supports (%d)", e.Found, e.Supported)
}

// MigrateOptions tune Migrate.
type MigrateOptions struct {
	DataDir string
	Clock   Clock
	// MaxVersion stops migrating at this version when above 0 (MaxMigrationCap in a testhooks build).
	MaxVersion int
}

// Migrate brings the schema up to date. A database newer than this build fails with
// *NewerSchemaError. Before any pending migration on a database that already holds
// data, an encrypted backup and a copy of the keyring land in <data>/backups.
func Migrate(ctx context.Context, s *db.Store, opts MigrateOptions) error {
	ms, err := loadMigrations()
	if err != nil {
		return err
	}
	cur, err := SchemaVersion(ctx, s)
	if err != nil {
		return err
	}
	if latest := ms[len(ms)-1].version; cur > latest {
		return &NewerSchemaError{Found: cur, Supported: latest}
	}
	var pending []migration
	for _, m := range ms {
		if m.version > cur && (opts.MaxVersion == 0 || m.version <= opts.MaxVersion) {
			pending = append(pending, m)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	if cur > 0 {
		if err := backupBeforeMigration(ctx, s, opts, cur); err != nil {
			return err
		}
	}
	for _, m := range pending {
		err := s.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, m.sql); err != nil {
				return err
			}
			return setSchemaVersion(ctx, db.New(tx), m.version)
		})
		if err != nil {
			return fmt.Errorf("migration %04d: %w", m.version, err)
		}
	}
	return nil
}

func backupBeforeMigration(ctx context.Context, s *db.Store, opts MigrateOptions, from int) error {
	dir := filepath.Join(opts.DataDir, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	stem := filepath.Join(dir, fmt.Sprintf("pre-migrate-v%d-%d", from, opts.Clock.Now().UnixMilli()))
	if err := s.Writer.Backup(ctx, stem+".db"); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(opts.DataDir, "keyring.json"), stem+".keyring.json"); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
