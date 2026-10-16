// Package platform owns the encrypted SQLite file, its migrations and the clock.
package platform

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/ext/fts5"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum" // registers the "adiantum" VFS
)

// DB is one encrypted connection, serialised by a mutex. S0 needs nothing more.
type DB struct {
	mu     sync.Mutex
	conn   *sqlite3.Conn
	hexKey string
}

// fileURI builds a SQLite URI for an absolute path on the adiantum VFS.
func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String() + "?vfs=adiantum"
}

// Open opens (or creates) the encrypted database at path. The key goes in by PRAGMA,
// never in the URI, so no other code can read it back from the file name (§6.2).
func Open(path string, dek []byte) (*DB, error) {
	conn, err := sqlite3.Open(fileURI(path))
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	d := &DB{conn: conn, hexKey: hex.EncodeToString(dek)}
	if err := d.init(); err != nil {
		conn.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) init() error {
	if err := d.conn.Exec("PRAGMA hexkey='" + d.hexKey + "'"); err != nil {
		return fmt.Errorf("key database: %w", err)
	}
	if err := fts5.Register(d.conn); err != nil {
		return fmt.Errorf("register fts5: %w", err)
	}
	for _, p := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA temp_store=MEMORY",
		"PRAGMA mmap_size=0",
		"PRAGMA secure_delete=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if err := d.conn.Exec(p); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
	}
	return nil
}

// Close closes the connection.
func (d *DB) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn.Close()
}

// Exec runs one statement with positional arguments (string, int, int64).
func (d *DB) Exec(sql string, args ...any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.exec(sql, args...)
}

func (d *DB) exec(sql string, args ...any) error {
	if len(args) == 0 {
		return d.conn.Exec(sql)
	}
	stmt, _, err := d.conn.Prepare(sql)
	if err != nil {
		return err
	}
	defer stmt.Close()
	if err := bind(stmt, args); err != nil {
		return err
	}
	return stmt.Exec()
}

// QueryString returns the first column of the first row as text.
func (d *DB) QueryString(sql string, args ...any) (value string, found bool, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.queryString(sql, args...)
}

func (d *DB) queryString(sql string, args ...any) (string, bool, error) {
	stmt, _, err := d.conn.Prepare(sql)
	if err != nil {
		return "", false, err
	}
	defer stmt.Close()
	if err := bind(stmt, args); err != nil {
		return "", false, err
	}
	if stmt.Step() {
		return stmt.ColumnText(0), true, nil
	}
	return "", false, stmt.Err()
}

// Query runs a read and calls row once per result row, with the statement positioned on it.
func (d *DB) Query(sql string, args []any, row func(*sqlite3.Stmt)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	stmt, _, err := d.conn.Prepare(sql)
	if err != nil {
		return err
	}
	defer stmt.Close()
	if err := bind(stmt, args); err != nil {
		return err
	}
	for stmt.Step() {
		row(stmt)
	}
	return stmt.Err()
}

func bind(stmt *sqlite3.Stmt, args []any) error {
	for i, a := range args {
		var err error
		switch v := a.(type) {
		case string:
			err = stmt.BindText(i+1, v)
		case int:
			err = stmt.BindInt(i+1, v)
		case int64:
			err = stmt.BindInt64(i+1, v)
		default:
			err = fmt.Errorf("unsupported bind type %T", a)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Tx runs fn in one transaction on the connection.
func (d *DB) Tx(fn func(exec func(sql string, args ...any) error) error) (err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	tx := d.conn.Begin()
	defer tx.End(&err)
	return fn(d.exec)
}

// backupTo copies the live database to a new file under the same key. The key
// is in the URI for this one target only; errors are scrubbed before they leave.
func (d *DB) backupTo(path string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.conn.Backup("main", fileURI(path)+"&hexkey="+d.hexKey); err != nil {
		return fmt.Errorf("backup: %s", strings.ReplaceAll(err.Error(), d.hexKey, "[key]"))
	}
	return nil
}
