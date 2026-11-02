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
	"strings"
	"time"

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
func Open(path string, dek []byte, opts ...Option) (*Store, error) {
	if err := ensureFile(path); err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	key := &secret{hex: hex.EncodeToString(dek)}
	w, err := openPool(path, key, true, o.observe)
	if err != nil {
		return nil, err
	}
	r, err := openPool(path, key, false, o.observe)
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

// fileURI builds a SQLite URI for an absolute path on the VFS vfsName names (the default VFS when it is empty).
// params is further "key=value" pairs for the query.
func fileURI(path string, params ...string) string {
	if vfs := vfsName(); vfs != "" {
		params = append([]string{"vfs=" + vfs}, params...)
	}
	uri := (&url.URL{Scheme: "file", Path: path}).String()
	if len(params) == 0 {
		return uri
	}
	return uri + "?" + strings.Join(params, "&")
}

func openPool(path string, key *secret, writer bool, observe func(string, time.Duration)) (*sql.DB, error) {
	var params []string
	if writer {
		params = append(params, "_txlock=immediate") // reads and writes in one tx must not upgrade a read lock
	}
	dsn := fileURI(path, params...)
	pool, err := sqlite.Open(dsn, key.initConn(writer, observe))
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
// observe, when set, hears of each finished statement; it is installed last, so the key PRAGMA is never traced.
func (s *secret) initConn(writer bool, observe func(string, time.Duration)) func(*sqlite3.Conn) error {
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
		if observe != nil {
			// TRACE_PROFILE fires once per finished statement with the statement and its run time in nanoseconds. Stmt.SQL is the
			// text as prepared, so a bound argument never reaches observe. With no observer no hook is installed: zero cost.
			return c.Trace(sqlite3.TRACE_PROFILE, func(_ sqlite3.TraceEvent, stmt, ns any) error {
				if st, ok := stmt.(*sqlite3.Stmt); ok {
					n, _ := ns.(int64)
					observe(st.SQL(), time.Duration(n))
				}
				return nil
			})
		}
		return nil
	}
}

// Writer serialises every write on the one writer connection.
type Writer struct {
	sql *sql.DB
	key *secret
}

// Tx is the open write transaction. It exposes sqlc's DBTX, so any module wraps it with
// its own generated New: db.New(tx.DBTX()), or mymodule.New(tx.DBTX()). Every module
// that does so writes in the same transaction.
type Tx struct{ tx *sql.Tx }

// DBTX is the handle for a module's generated New.
func (t *Tx) DBTX() DBTX { return t.tx }

// SQL is the underlying transaction, for plain SQL (migrations, FTS maintenance).
func (t *Tx) SQL() *sql.Tx { return t.tx }

// txKey is per Writer: a ctx that carries writer A's transaction must never be
// reused as a transaction of writer B (another database).
type txKey struct{ w *Writer }

// Tx runs fn in one write transaction (BEGIN IMMEDIATE). fn may read and write; an
// error or panic rolls back. The ctx given to fn carries the transaction: a nested
// Tx call with that ctx reuses it (the one writer connection would otherwise
// deadlock waiting for itself), and the outer commit or rollback covers it. A nested
// call with a ctx that does not carry the transaction still blocks.
func (w *Writer) Tx(ctx context.Context, fn func(ctx context.Context, tx *Tx) error) error {
	if open, ok := ctx.Value(txKey{w}).(*Tx); ok {
		return fn(ctx, open)
	}
	sqlTx, err := w.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = sqlTx.Rollback() }() // harmless after Commit
	tx := &Tx{tx: sqlTx}
	if err := fn(context.WithValue(ctx, txKey{w}, tx), tx); err != nil {
		return err
	}
	return sqlTx.Commit()
}

// SQLTx is Tx for code that needs plain SQL.
func (w *Writer) SQLTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return w.Tx(ctx, func(_ context.Context, tx *Tx) error { return fn(tx.tx) })
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
		return driverConn.(sqlite.Conn).Raw().Backup("main", fileURI(path, "hexkey="+w.key.hex))
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

// IsUniqueViolation reports whether err is SQLite refusing a duplicate in a unique index.
func IsUniqueViolation(err error) bool { return errors.Is(err, sqlite3.CONSTRAINT_UNIQUE) }

// IsTriggerAbort reports whether err is a trigger raising ABORT (the schema's own rules, e.g. I-37).
func IsTriggerAbort(err error) bool { return errors.Is(err, sqlite3.CONSTRAINT_TRIGGER) }

// IsInterrupted reports whether err is SQLite stopping a statement because its context was cancelled.
func IsInterrupted(err error) bool { return errors.Is(err, sqlite3.INTERRUPT) }

// Option changes how Open builds the pools.
type Option func(*options)

type options struct {
	observe func(sql string, d time.Duration)
}

// WithQueryObserver calls fn once per finished statement on any connection of either pool, with the SQL text as prepared (never
// the bound arguments) and how long it ran. fn runs on the query's own goroutine, inside the driver: it must be quick.
func WithQueryObserver(fn func(sql string, d time.Duration)) Option {
	return func(o *options) { o.observe = fn }
}
