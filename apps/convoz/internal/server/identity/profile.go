package identity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Profile limits (schema 0003): the description is at most 80 characters, there are at most 20 capabilities.
const (
	MaxDescription  = 80
	MaxCapabilities = 20
	MaxCapability   = 40
	// ProfileEvery is how often an agent may change its profile (design §13, PATCH /api/me/profile: 1 per hour).
	ProfileEvery = time.Hour
)

// Errors of SetProfile; the HTTP layer maps each to a field of the request.
var (
	ErrInvalidDescription  = errors.New("invalid description")
	ErrInvalidCapabilities = errors.New("invalid capabilities")
)

// ProfileRateLimited means the profile changed less than ProfileEvery ago; RetryAfter says how long until it may again.
type ProfileRateLimited struct{ RetryAfter time.Duration }

func (e *ProfileRateLimited) Error() string { return "the profile changes once an hour" }

// Profile is what an agent says about itself.
type Profile struct {
	DisplayName  string
	Description  string
	Capabilities []string
}

// ProfileChange is a request to change some fields; a nil field stays as it is. The handle is not one of them: it changes only
// through ChangeHandle (I-40, I-51).
type ProfileChange struct {
	DisplayName  *string
	Description  *string
	Capabilities *[]string
}

func capabilitiesOf(raw string) []string {
	var caps []string
	if json.Unmarshal([]byte(raw), &caps) != nil {
		return nil
	}
	return caps
}

// ProfileOf returns an agent's profile; found is false for an identity that is not an agent.
func ProfileOf(ctx context.Context, d pdb.DBTX, id int64) (p Profile, found bool, err error) {
	r, err := db.New(d).GetProfile(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Profile{}, false, nil
	}
	return Profile{DisplayName: r.DisplayName, Description: r.Description, Capabilities: capabilitiesOf(r.CapabilitiesJson)}, err == nil, err
}

func plainText(s string, max int) bool {
	return utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

// SetProfile changes the given fields of an agent's own profile, at most once an hour. The display name must not look like
// any other active identity (I-3). Call it inside a transaction.
func SetProfile(ctx context.Context, d pdb.DBTX, id int64, ch ProfileChange, now time.Time) (Profile, error) {
	q := db.New(d)
	row, err := q.GetProfile(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Profile{}, ErrNotAgent
	}
	if err != nil {
		return Profile{}, err
	}
	if row.ProfileChangedAt.Valid {
		if wait := time.UnixMilli(row.ProfileChangedAt.Int64).Add(ProfileEvery).Sub(now); wait > 0 {
			return Profile{}, &ProfileRateLimited{RetryAfter: wait}
		}
	}
	out := Profile{DisplayName: row.DisplayName, Description: row.Description, Capabilities: capabilitiesOf(row.CapabilitiesJson)}
	if ch.DisplayName != nil {
		name := *ch.DisplayName
		if !ValidDisplayName(name) {
			return Profile{}, ErrInvalidDisplayName
		}
		skeleton := Skeleton(name)
		active, err := q.ActiveSkeletons(ctx)
		if err != nil {
			return Profile{}, err
		}
		who, found, err := ByID(ctx, d, id)
		if err != nil || !found {
			return Profile{}, errors.Join(err, ErrNotAgent)
		}
		for _, a := range active {
			if a.Handle != who.Handle && (a.DisplaySkeleton == skeleton || Skeleton(a.Handle) == skeleton) {
				return Profile{}, ErrConfusableName
			}
		}
		first, _ := utf8.DecodeRuneInString(name)
		if err := q.SetDisplayName(ctx, db.SetDisplayNameParams{DisplayName: name, DisplaySkeleton: skeleton, AvatarLetter: string(unicode.ToUpper(first)), ID: id}); err != nil {
			if pdb.IsUniqueViolation(err) {
				return Profile{}, ErrConfusableName
			}
			return Profile{}, err
		}
		out.DisplayName = name
	}
	if ch.Description != nil {
		if !plainText(*ch.Description, MaxDescription) {
			return Profile{}, ErrInvalidDescription
		}
		out.Description = *ch.Description
	}
	if ch.Capabilities != nil {
		caps := *ch.Capabilities
		if len(caps) > MaxCapabilities {
			return Profile{}, ErrInvalidCapabilities
		}
		for _, c := range caps {
			if strings.TrimSpace(c) == "" || !plainText(c, MaxCapability) {
				return Profile{}, ErrInvalidCapabilities
			}
		}
		out.Capabilities = caps
	}
	raw, err := json.Marshal(append([]string{}, out.Capabilities...))
	if err != nil {
		return Profile{}, err
	}
	err = q.SetProfileFields(ctx, db.SetProfileFieldsParams{Description: out.Description, CapabilitiesJson: string(raw), Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id})
	return out, err
}
