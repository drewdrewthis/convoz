package auth

import (
	"path"
	"regexp"
)

// Allow modes of a machine.
const (
	AllowList = "list" // only the listed identities and globs
	AllowAny  = "any"  // every agent
)

// Allow says which agent identities a machine may run sessions as (design §2.2). Identities are ids; globs
// use `*` and `?` and are matched against the handle.
type Allow struct {
	Mode        string
	IdentityIDs []int64
	Globs       []string
}

var globRE = regexp.MustCompile(`^[a-z0-9*?-]{1,40}$`)

// ValidGlob reports whether g can be stored as an allow-list glob.
func ValidGlob(g string) bool { return globRE.MatchString(g) }

// Covers reports whether the allow-list lets the machine act as the identity with this id and handle.
// It is the Go twin of the sessions_identity_allowed trigger, which stays the last word (I-37).
func (a Allow) Covers(identityID int64, handle string) bool {
	if a.Mode == AllowAny {
		return true
	}
	for _, id := range a.IdentityIDs {
		if id == identityID {
			return true
		}
	}
	return a.CoversHandle(handle)
}

// CoversHandle reports whether the mode or a glob covers handle. An identity that does not exist yet
// can only be covered this way.
func (a Allow) CoversHandle(handle string) bool {
	if a.Mode == AllowAny {
		return true
	}
	for _, g := range a.Globs {
		if ok, _ := path.Match(g, handle); ok {
			return true
		}
	}
	return false
}
