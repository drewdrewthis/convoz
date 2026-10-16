// Package identity owns principals: one identities row per human or agent (design §7, I-1..I-3).
package identity

import (
	"context"
	"database/sql"
	"errors"
	"hash/fnv"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Human is a person with an account.
type Human struct {
	ID          int64
	Handle      string
	DisplayName string
	Role        string
}

// Entry is one row of the identity list: a human or an agent.
type Entry struct {
	ID          int64  `json:"id"`
	Kind        string `json:"kind"`
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	CreatedAt   int64  `json:"created_at"`
	Disabled    bool   `json:"disabled"`
}

// ErrNotFound means no such human.
var ErrNotFound = errors.New("identity not found")

// ErrInvalid means a handle or display name that the schema would refuse.
var ErrInvalid = errors.New("invalid handle or display name")

var handleRE = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)

// ValidHandle reports whether s can be a handle (2 to 40 of a-z 0-9 -, starting with a letter).
func ValidHandle(s string) bool { return handleRE.MatchString(s) }

// ValidDisplayName reports whether s is 1 to 80 characters without control characters.
func ValidDisplayName(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > 80 || strings.TrimSpace(s) == "" {
		return false
	}
	return !strings.ContainsFunc(s, unicode.IsControl)
}

// CreateOwner inserts the one owner (I-1). The unique owner index refuses a second.
// The skeleton is the lowercased name for now; the confusables table arrives with crew.
func CreateOwner(ctx context.Context, d pdb.DBTX, handle, displayName string, now time.Time) (Human, error) {
	q := db.New(d)
	if !ValidHandle(handle) || !ValidDisplayName(displayName) {
		return Human{}, ErrInvalid
	}
	first, _ := utf8.DecodeRuneInString(displayName)
	h := fnv.New32a()
	_, _ = h.Write([]byte(handle))
	id, err := q.InsertIdentity(ctx, db.InsertIdentityParams{
		Kind:            "human",
		Handle:          handle,
		DisplayName:     displayName,
		DisplaySkeleton: strings.ToLower(displayName),
		AvatarLetter:    string(unicode.ToUpper(first)),
		AvatarPalette:   int64(h.Sum32() % 12),
		CreatedAt:       now.UnixMilli(),
	})
	if err != nil {
		return Human{}, err
	}
	if err := q.InsertHuman(ctx, db.InsertHumanParams{IdentityID: id, Role: "owner", CreatedVia: "bootstrap"}); err != nil {
		return Human{}, err
	}
	return Human{ID: id, Handle: handle, DisplayName: displayName, Role: "owner"}, nil
}

// Owner returns the owner, or ErrNotFound before the first bootstrap.
func Owner(ctx context.Context, d pdb.DBTX) (Human, error) {
	q := db.New(d)
	r, err := q.GetOwner(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return Human{}, ErrNotFound
	}
	return Human{ID: r.ID, Handle: r.Handle, DisplayName: r.DisplayName, Role: r.Role}, err
}

// Get returns one human by id.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Human, error) {
	q := db.New(d)
	r, err := q.GetHuman(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Human{}, ErrNotFound
	}
	return Human{ID: r.ID, Handle: r.Handle, DisplayName: r.DisplayName, Role: r.Role}, err
}

// ByHandle returns one human by handle.
func ByHandle(ctx context.Context, d pdb.DBTX, handle string) (Human, error) {
	q := db.New(d)
	r, err := q.GetHumanByHandle(ctx, handle)
	if errors.Is(err, sql.ErrNoRows) {
		return Human{}, ErrNotFound
	}
	return Human{ID: r.ID, Handle: r.Handle, DisplayName: r.DisplayName, Role: r.Role}, err
}

// List returns every identity, oldest first.
func List(ctx context.Context, d pdb.DBTX) ([]Entry, error) {
	q := db.New(d)
	rows, err := q.ListIdentities(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(rows))
	for _, r := range rows {
		out = append(out, Entry{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Role: r.Role, CreatedAt: r.CreatedAt, Disabled: r.DisabledAt.Valid})
	}
	return out, nil
}
