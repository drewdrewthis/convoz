package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type seen struct {
	mu   sync.Mutex
	sqls []string
}

func (s *seen) observe(q string, _ time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sqls = append(s.sqls, q)
}

func (s *seen) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.sqls...)
}

func openObserved(t *testing.T, o *seen) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"), make([]byte, 32), WithQueryObserver(o.observe)) // TESTONLY key
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Writer.SQLTx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec("CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT)")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAStoreOpenedWithAnObserverReportsEachSqlcQueryByItsSQLText(t *testing.T) {
	var o seen
	s := openObserved(t, &o)
	ctx := context.Background()
	if err := s.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
		return set(ctx, New(tx), "TESTONLY-key")
	}); err != nil {
		t.Fatal(err)
	}
	_ = has(t, s, "TESTONLY-key")

	t.Run("a write is reported with its name line", func(t *testing.T) {
		if !anyHasPrefix(o.all(), "-- name: SetKV") {
			t.Errorf("no observed statement starts with %q; saw %q", "-- name: SetKV", o.all())
		}
	})
	t.Run("a read on the reader pool is reported with its name line", func(t *testing.T) {
		if !anyHasPrefix(o.all(), "-- name: GetKV") {
			t.Errorf("no observed statement starts with %q; saw %q", "-- name: GetKV", o.all())
		}
	})
	t.Run("the bound argument value never reaches the observer", func(t *testing.T) {
		for _, q := range o.all() {
			if strings.Contains(q, "TESTONLY-key") {
				t.Errorf("an argument value reached the observer: %q", q)
			}
		}
	})
}

func TestAStoreOpenedWithoutAnObserverStillWorks(t *testing.T) {
	s := openTest(t)
	if has(t, s, "absent") {
		t.Error("an absent key was found")
	}
}

func anyHasPrefix(list []string, prefix string) bool {
	for _, s := range list {
		if strings.HasPrefix(strings.TrimSpace(s), prefix) {
			return true
		}
	}
	return false
}
