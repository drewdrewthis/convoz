// Package identity owns principals: one identities row per human or agent (design §7, I-1..I-3).
package identity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
	// Description and Capabilities are an agent's own words about itself (PATCH /api/me/profile); empty for a human.
	Description  string   `json:"description,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	// Triage marks a triage agent: the owner let it read every conversation and thread, post in them and add or remove agents anywhere
	// (migrations 0038, 0040). List leaves it false (it must run on every release's schema); TriageIDs says who has it.
	Triage bool `json:"triage,omitempty"`
	// AvatarURL is where the identity's own SVG avatar is served (I-32); empty for the letter on a tint.
	AvatarURL string `json:"avatar_url,omitempty"`
	// PreviousHandles are the handles an agent had before, newest first (I-51); a mention of one still names it.
	PreviousHandles []string `json:"previous_handles,omitempty"`
	// HandleChangedAt is when an agent's handle last changed (epoch ms); 0 when it never did.
	HandleChangedAt int64 `json:"handle_changed_at,omitempty"`
	// CreatedByHuman and CreatedByMachine are the ids that made an agent; the composition root turns
	// them into names (the machine is auth's).
	CreatedByHuman   int64 `json:"-"`
	CreatedByMachine int64 `json:"-"`
}

// ErrNotFound means no such human.
var ErrNotFound = errors.New("identity not found")

// ErrInvalid means a handle or display name that the schema would refuse.
var ErrInvalid = errors.New("invalid handle or display name")

var handleRE = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)

// ValidHandle reports whether s can be a handle (2 to 40 of a-z 0-9 -, starting with a letter).
func ValidHandle(s string) bool { return handleRE.MatchString(s) }

// ValidDisplayName reports whether s is 1 to 80 characters without control or format characters
// (bidi marks, zero-width), which could reorder or hide what a reader sees next to a name.
func ValidDisplayName(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > 80 || strings.TrimSpace(s) == "" {
		return false
	}
	return !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

// newIdentity inserts one identities row for a valid handle and display name and returns its id.
func newIdentity(ctx context.Context, q *db.Queries, kind, handle, displayName string, now time.Time) (int64, error) {
	first, _ := utf8.DecodeRuneInString(displayName)
	h := fnv.New32a()
	_, _ = h.Write([]byte(handle))
	return q.InsertIdentity(ctx, db.InsertIdentityParams{
		Kind:            kind,
		Handle:          handle,
		DisplayName:     displayName,
		DisplaySkeleton: Skeleton(displayName),
		AvatarLetter:    string(unicode.ToUpper(first)),
		AvatarPalette:   int64(h.Sum32() % 12),
		CreatedAt:       now.UnixMilli(),
	})
}

// CreateOwner inserts the one owner (I-1). The unique owner index refuses a second.
func CreateOwner(ctx context.Context, d pdb.DBTX, handle, displayName string, now time.Time) (Human, error) {
	q := db.New(d)
	if !ValidHandle(handle) || !ValidDisplayName(displayName) {
		return Human{}, ErrInvalid
	}
	id, err := newIdentity(ctx, q, "human", handle, displayName, now)
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
		e := Entry{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Role: r.Role, CreatedAt: r.CreatedAt, Disabled: r.DisabledAt.Valid,
			CreatedByHuman: r.CreatedByHuman.Int64, CreatedByMachine: r.CreatedByMachine.Int64, Description: r.Description, Capabilities: capabilitiesOf(r.CapabilitiesJson)}
		e.HandleChangedAt = r.HandleChangedAt
		if err := json.Unmarshal([]byte(r.PreviousHandlesJson), &e.PreviousHandles); err != nil {
			return nil, err
		}
		if len(e.PreviousHandles) == 0 {
			e.PreviousHandles = nil
		}
		e.AvatarURL = AvatarURL(r.ID, r.AvatarSvg)
		out = append(out, e)
	}
	return out, nil
}

// AvatarURL is where an identity's avatar is served, "" when it has none. The version in the query changes with the SVG, so a
// changed avatar is a new URL and no page keeps showing the old picture from its image cache.
func AvatarURL(id int64, svg string) string {
	if svg == "" {
		return ""
	}
	return fmt.Sprintf("/api/identities/%d/avatar.svg?v=%s", id, AvatarVersion(svg))
}

// AvatarVersion names one SVG avatar: two different avatars get different names.
func AvatarVersion(svg string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(svg))
	return fmt.Sprintf("%016x", h.Sum64())
}

// SetAvatar stores an identity's sanitized SVG avatar (the caller cleaned it, I-32); an empty string clears it.
func SetAvatar(ctx context.Context, d pdb.DBTX, id int64, svg string) error {
	return db.New(d).SetAvatarSVG(ctx, db.SetAvatarSVGParams{ID: id, Svg: sql.NullString{String: svg, Valid: svg != ""}})
}

// Avatar returns an identity's SVG avatar. ok is false when it has none.
func Avatar(ctx context.Context, d pdb.DBTX, id int64) (svg string, ok bool, err error) {
	v, err := db.New(d).GetAvatarSVG(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v.String, err == nil && v.Valid, err
}

// IsTriage says whether id is an enabled agent the owner let read every conversation.
func IsTriage(ctx context.Context, d pdb.DBTX, id int64) (bool, error) {
	return db.New(d).AgentIsTriage(ctx, id)
}

// SetTriage turns the triage right of an agent on or off. It reports false when there is no such agent.
func SetTriage(ctx context.Context, d pdb.DBTX, id int64, on bool) (bool, error) {
	v := int64(0)
	if on {
		v = 1
	}
	n, err := db.New(d).SetAgentTriage(ctx, db.SetAgentTriageParams{On: v, ID: id})
	return n > 0, err
}

// TriageIDs is the set of agents that hold the triage right.
func TriageIDs(ctx context.Context, d pdb.DBTX) (map[int64]bool, error) {
	ids, err := db.New(d).ListTriage(ctx)
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, err
}
