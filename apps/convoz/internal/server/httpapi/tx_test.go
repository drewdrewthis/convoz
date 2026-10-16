package httpapi

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	identity "github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func migratedStore(t *testing.T) *pdb.Store {
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

// present reads, outside any transaction, whether the owner row and the bootstrap link made in a test exist.
func present(t *testing.T, s *pdb.Store, token string) (owner, link bool) {
	t.Helper()
	d := s.Reader.SQL()
	list, err := identity.List(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	_, state, err := auth.CheckBootstrapLink(context.Background(), d, token, platform.SystemClock{}.Now())
	if err != nil {
		t.Fatal(err)
	}
	return len(list) > 0, state != auth.LinkUnknown
}

// The identity and auth modules each wrap the one open transaction with their own sqlc package.
// An error after both wrote leaves neither row, and a nested Writer.Tx with the callback ctx joins it.
func TestIdentityAndAuthShareOneTransaction(t *testing.T) {
	s := migratedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	now := platform.SystemClock{}.Now()
	boom := errors.New("boom")

	var token string
	err := s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, err := identity.CreateOwner(ctx, d, "drew", "Drew", now); err != nil {
			return err
		}
		var err error
		token, _, err = auth.MintBootstrapLink(ctx, d, now)
		if err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	if owner, link := present(t, s, token); owner || link {
		t.Fatalf("rollback left rows behind: owner=%v link=%v", owner, link)
	}

	err = s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		if _, err := identity.CreateOwner(ctx, tx.DBTX(), "drew", "Drew", now); err != nil {
			return err
		}
		// The nested call must reuse the transaction; the one writer connection would deadlock otherwise.
		if err := s.Writer.Tx(ctx, func(ctx context.Context, inner *pdb.Tx) error {
			if inner != tx {
				t.Error("nested call opened a second transaction")
			}
			var err error
			token, _, err = auth.MintBootstrapLink(ctx, inner.DBTX(), now)
			return err
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
	if owner, link := present(t, s, token); owner || link {
		t.Fatalf("outer rollback must cover the nested write: owner=%v link=%v", owner, link)
	}

	err = s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, err := identity.CreateOwner(ctx, d, "drew", "Drew", now); err != nil {
			return err
		}
		var err error
		token, _, err = auth.MintBootstrapLink(ctx, d, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if owner, link := present(t, s, token); !owner || !link {
		t.Fatalf("commit lost a write: owner=%v link=%v", owner, link)
	}
}

// inTx runs fn in one write transaction, bounded by a timeout.
func inTx(t *testing.T, s *pdb.Store, fn func(ctx context.Context, d pdb.DBTX) error) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error { return fn(ctx, tx.DBTX()) })
}
