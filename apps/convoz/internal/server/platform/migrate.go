package platform

import (
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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

// SchemaVersion reads the stored schema version; 0 means a fresh database.
func (d *DB) SchemaVersion() (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.schemaVersion()
}

func (d *DB) schemaVersion() (int, error) {
	_, has, err := d.queryString("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_kv'")
	if err != nil || !has {
		return 0, err
	}
	v, has, err := d.queryString("SELECT value FROM system_kv WHERE key='schema_version'")
	if err != nil || !has {
		return 0, err
	}
	return strconv.Atoi(v)
}

// SetSchemaVersion overwrites the stored version. Only the test hooks and the runner call it.
func (d *DB) SetSchemaVersion(v int) error {
	return d.Exec(setVersionSQL, strconv.Itoa(v))
}

const setVersionSQL = "INSERT INTO system_kv(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"

// MigrateOptions tune Migrate.
type MigrateOptions struct {
	DataDir string
	Clock   Clock
	// MaxVersion stops migrating at this version when above 0 (test hooks simulate the previous release).
	MaxVersion int
}

// Migrate brings the schema up to date. A database newer than this build fails with
// *NewerSchemaError. Before any pending migration on a database that already holds
// data, an encrypted backup and a copy of the keyring land in <data>/backups.
func (d *DB) Migrate(opts MigrateOptions) error {
	ms, err := loadMigrations()
	if err != nil {
		return err
	}
	cur, err := d.SchemaVersion()
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
		if err := d.backupBeforeMigration(opts, cur); err != nil {
			return err
		}
	}
	for _, m := range pending {
		err := d.Tx(func(exec func(string, ...any) error) error {
			if err := exec(m.sql); err != nil {
				return err
			}
			return exec(setVersionSQL, strconv.Itoa(m.version))
		})
		if err != nil {
			return fmt.Errorf("migration %04d: %w", m.version, err)
		}
	}
	return nil
}

func (d *DB) backupBeforeMigration(opts MigrateOptions, from int) error {
	dir := filepath.Join(opts.DataDir, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	stem := filepath.Join(dir, fmt.Sprintf("pre-migrate-v%d-%d", from, opts.Clock.Now().UnixMilli()))
	if err := d.backupTo(stem + ".db"); err != nil {
		return err
	}
	return copyFile(filepath.Join(opts.DataDir, "keyring.json"), stem+".keyring.json")
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
	return out.Close()
}
