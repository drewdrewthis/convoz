package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// BootstrapTTL is how long a bootstrap link works.
const BootstrapTTL = 10 * time.Minute

// LinkState is what a bootstrap token is worth right now.
type LinkState int

// The states of a bootstrap token.
const (
	LinkOK LinkState = iota
	LinkUnknown
	LinkUsed
	LinkExpired
)

// ErrLinkUsed means another request used the link first.
var ErrLinkUsed = errors.New("bootstrap link already used")

// MintBootstrapLink stores a new one-time link and returns its token (shown once, never stored).
func MintBootstrapLink(ctx context.Context, d pdb.DBTX, now time.Time) (string, time.Time, error) {
	q := db.New(d)
	token := newToken(PrefixBootstrap)
	expires := now.Add(BootstrapTTL)
	err := q.InsertBootstrapLink(ctx, db.InsertBootstrapLinkParams{TokenHash: hashToken(token), CreatedAt: now.UnixMilli(), ExpiresAt: expires.UnixMilli()})
	return token, expires, err
}

// CheckBootstrapLink says whether token can still register a passkey. It changes nothing.
func CheckBootstrapLink(ctx context.Context, d pdb.DBTX, token string, now time.Time) (int64, LinkState, error) {
	q := db.New(d)
	row, err := q.GetBootstrapLink(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, LinkUnknown, nil
	}
	if err != nil {
		return 0, LinkUnknown, err
	}
	switch {
	case row.UsedAt.Valid:
		return row.ID, LinkUsed, nil
	case now.UnixMilli() > row.ExpiresAt:
		return row.ID, LinkExpired, nil
	}
	return row.ID, LinkOK, nil
}

// UseBootstrapLink spends the link for a passkey. Only one caller can win.
func UseBootstrapLink(ctx context.Context, d pdb.DBTX, linkID, passkeyID int64, now time.Time) error {
	q := db.New(d)
	n, err := q.UseBootstrapLink(ctx, db.UseBootstrapLinkParams{
		UsedAt:    sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		PasskeyID: sql.NullInt64{Int64: passkeyID, Valid: true},
		ID:        linkID,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrLinkUsed
	}
	return nil
}
