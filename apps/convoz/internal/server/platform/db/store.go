// Package db opens the encrypted SQLite file through database/sql: one writer
// connection for every write, a pool of read-only connections, and the sqlc-generated
// Queries on top of both (design §4.1, §4.2).
package db

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"

	"github.com/ncruces/go-sqlite3"
	sqlite "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/fts5"
	_ "github.com/ncruces/go-sqlite3/vfs/adiantum" // registers the "adiantum" VFS
)

// ErrWrongKey means the file is there but not readable under the key it was opened with.
var ErrWrongKey = errors.New("the database file cannot be read with this key (wrong keyring or KEK, or not a Convoz database)")

// maxReaders caps the read pool; reads are cheap and WAL lets them run beside the writer.
const maxReaders = 8

// Store is the writer plus the reader pool over one database file.
type Store struct {
	Writer *Writer
	Reader *Reader
}

// Open opens (or creates) the encrypted database at path, owner-only (0600). The key goes
// in by PRAGMA on every new connection, never in the URI, so nothing can read it back
// from a file name (§6.2).
func Open(path string, dek []byte) (*Store, error) {
	if err := ensureFile(path); err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	key := &secret{hex: hex.EncodeToString(dek)}
	w, err := openPool(path, key, true)
	if err != nil {
		return nil, err
	}
	r, err := openPool(path, key, false)
	if err != nil {
		_ = w.Close()
		return nil, err
	}
	w.SetMaxOpenConns(1) // one writer: SQLite has one write lock anyway
	r.SetMaxOpenConns(min(runtime.GOMAXPROCS(0), maxReaders))
	return &Store{Writer: &Writer{sql: w, key: key}, Reader: &Reader{sql: r}}, nil
}

// Close closes both pools.
func (s *Store) Close() error {
	return errors.Join(s.Reader.sql.Close(), s.Writer.sql.Close())
}

// ensureFile creates the file owner-only, or tightens an existing one, before SQLite
// sees it: SQLite gives its -wal and -shm files the mode of the main file.
func ensureFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// fileURI builds a SQLite URI for an absolute path on the adiantum VFS.
func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String() + "?vfs=adiantum"
}

func openPool(path string, key *secret, writer bool) (*sql.DB, error) {
	dsn := fileURI(path)
	if writer {
		dsn += "&_txlock=immediate" // reads and writes in one tx must not upgrade a read lock
	}
	pool, err := sqlite.Open(dsn, key.initConn(writer))
	if err != nil {
		return nil, key.scrub(fmt.Errorf("open database: %w", err))
	}
	if err := pool.Ping(); err != nil {
		_ = pool.Close()
		return nil, key.scrub(fmt.Errorf("open database: %w", err))
	}
	return pool, nil
}

// initConn is the per-connection hook: key first, then the extensions and settings.
func (s *secret) initConn(writer bool) func(*sqlite3.Conn) error {
	pragmas := []string{
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA temp_store=MEMORY",
		"PRAGMA mmap_size=0",
		"PRAGMA secure_delete=ON",
		"PRAGMA busy_timeout=5000",
	}
	if writer {
		pragmas = append([]string{"PRAGMA journal_mode=WAL"}, pragmas...)
	} else {
		pragmas = append(pragmas, "PRAGMA query_only=ON")
	}
	return func(c *sqlite3.Conn) error {
		if err := c.Exec("PRAGMA hexkey='" + s.hex + "'"); err != nil {
			return s.scrub(fmt.Errorf("key database: %w", err))
		}
		// Reading the header is what fails under a wrong key, so probe before anything else touches the file.
		if err := c.Exec("SELECT 1 FROM sqlite_master LIMIT 1"); err != nil {
			if errors.Is(err, sqlite3.NOTADB) {
				return ErrWrongKey
			}
			return fmt.Errorf("read database: %w", err)
		}
		if err := fts5.Register(c); err != nil {
			return fmt.Errorf("register fts5: %w", err)
		}
		for _, p := range pragmas {
			if err := c.Exec(p); err != nil {
				return fmt.Errorf("%s: %w", p, err)
			}
		}
		return nil
	}
}

// Writer serialises every write on the one writer connection.
type Writer struct {
	sql *sql.DB
	key *secret
}

// Tx runs fn in one write transaction (BEGIN IMMEDIATE). fn may read and write; an
// error or panic rolls back.
func (w *Writer) Tx(ctx context.Context, fn func(q *Queries) error) error {
	return w.SQLTx(ctx, func(tx *sql.Tx) error { return fn(New(tx)) })
}

// SQLTx is Tx for code that needs plain SQL (migrations, FTS maintenance, benchmarks).
func (w *Writer) SQLTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := w.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // harmless after Commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// Backup copies the live database to a new owner-only file under the same key. The
// key is in the URI for this one target only (§6.2 exception); errors are scrubbed.
func (w *Writer) Backup(ctx context.Context, path string) error {
	dst, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	if err := dst.Close(); err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	conn, err := w.sql.Conn(ctx)
	if err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	defer conn.Close()
	err = conn.Raw(func(driverConn any) error {
		return driverConn.(sqlite.Conn).Raw().Backup("main", fileURI(path)+"&hexkey="+w.key.hex)
	})
	if err != nil {
		return w.key.scrub(fmt.Errorf("backup: %w", err))
	}
	return nil
}

// Reader is the read-only pool.
type Reader struct{ sql *sql.DB }

// Read runs fn in one read transaction, so every query in it sees the same snapshot.
func (r *Reader) Read(ctx context.Context, fn func(q *Queries) error) error {
	tx, err := r.sql.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	return fn(New(tx))
}

// SQL exposes the pool for plain SQL reads.
func (r *Reader) SQL() *sql.DB { return r.sql }
