package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"), make([]byte, 32)) // TESTONLY key
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

func has(t *testing.T, s *Store, key string) bool {
	t.Helper()
	_, err := New(s.Reader.SQL()).GetKV(context.Background(), key)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	return err == nil
}

func set(ctx context.Context, q *Queries, key string) error {
	return q.SetKV(ctx, SetKVParams{Key: key, Value: sql.NullString{String: "v", Valid: true}})
}

// Two modules each wrap the same open transaction with their own query set.
func TestTxSharedByTwoModulesRollsBackTogether(t *testing.T) {
	s := openTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	boom := errors.New("boom")
	err := s.Writer.Tx(ctx, func(ctx context.Context, tx *Tx) error {
		moduleA, moduleB := New(tx.DBTX()), New(tx.DBTX())
		if err := set(ctx, moduleA, "a"); err != nil {
			return err
		}
		if err := set(ctx, moduleB, "b"); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if has(t, s, "a") || has(t, s, "b") {
		t.Fatal("rollback left a write behind")
	}
	if err := s.Writer.Tx(ctx, func(ctx context.Context, tx *Tx) error {
		if err := set(ctx, New(tx.DBTX()), "a"); err != nil {
			return err
		}
		return set(ctx, New(tx.DBTX()), "b")
	}); err != nil {
		t.Fatal(err)
	}
	if !has(t, s, "a") || !has(t, s, "b") {
		t.Fatal("commit lost a write")
	}
}

// A cross-call that opens Tx again with the callback ctx joins the open transaction.
func TestNestedTxReusesOpenTransaction(t *testing.T) {
	s := openTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	boom := errors.New("boom")
	err := s.Writer.Tx(ctx, func(ctx context.Context, tx *Tx) error {
		if err := set(ctx, New(tx.DBTX()), "outer"); err != nil {
			return err
		}
		if err := s.Writer.Tx(ctx, func(ctx context.Context, inner *Tx) error {
			if inner != tx {
				t.Error("nested call opened a second transaction")
			}
			return set(ctx, New(inner.DBTX()), "inner")
		}); err != nil {
			return err
		}
		return boom
	})
	if ctx.Err() != nil {
		t.Fatal("deadlocked until the context timeout")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if has(t, s, "outer") || has(t, s, "inner") {
		t.Fatal("the outer rollback must cover the nested write")
	}
}

// A ctx that carries writer A's transaction must not be taken as a transaction of writer B.
func TestTxKeyIsPerWriter(t *testing.T) {
	a, b := openTest(t), openTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	boom := errors.New("boom")
	err := a.Writer.Tx(ctx, func(ctxA context.Context, txA *Tx) error {
		if err := b.Writer.Tx(ctxA, func(ctxB context.Context, txB *Tx) error {
			if txB == txA {
				t.Error("writer B reused writer A's transaction")
			}
			return set(ctxB, New(txB.DBTX()), "in-b")
		}); err != nil {
			return err
		}
		return boom // rolls back A only
	})
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if !has(t, b, "in-b") {
		t.Fatal("B's own commit was lost with A's rollback")
	}
	if has(t, a, "in-b") {
		t.Fatal("B's write landed in A")
	}
}
