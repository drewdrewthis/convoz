package auth

import (
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// CeremonyTTL is how long a started WebAuthn ceremony can be finished.
const CeremonyTTL = 5 * time.Minute

// maxCeremonies bounds memory; public routes are rate limited, this is the second wall.
const maxCeremonies = 2_000

// Ceremony is the server-side state of one started WebAuthn ceremony. It lives in memory only:
// a restart drops ceremonies in flight, and the person just starts again.
type Ceremony struct {
	Kind    string // "bootstrap", "register", "login", "stepup"
	Session webauthn.SessionData
	Expires time.Time

	Token    string // bootstrap: the link token, checked again at verify
	Handle   string // bootstrap: the owner handle (first owner only)
	Display  string // bootstrap: the owner display name (first owner only)
	HumanID  int64  // register and stepup: whose passkey
	DeviceID int64  // register and stepup: the device that asked
	Action   string // stepup: the one action it allows
	TargetID *int64 // stepup: its target
}

// Ceremonies is the in-memory ceremony store.
type Ceremonies struct {
	mu sync.Mutex
	m  map[string]*Ceremony
}

// Put stores c and returns its random id. It returns "" when the store is full.
func (s *Ceremonies) Put(c *Ceremony, now time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[string]*Ceremony{}
	}
	if len(s.m) >= maxCeremonies {
		for id, old := range s.m {
			if now.After(old.Expires) {
				delete(s.m, id)
			}
		}
		if len(s.m) >= maxCeremonies {
			return ""
		}
	}
	id := randomBase62(32)
	c.Expires = now.Add(CeremonyTTL)
	s.m[id] = c
	return id
}

// Take removes and returns the ceremony if it exists, is of kind and has not expired.
// A ceremony can be finished once; a failed finish needs a new start.
func (s *Ceremonies) Take(id, kind string, now time.Time) (*Ceremony, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.m[id]
	if !ok {
		return nil, false
	}
	delete(s.m, id)
	if c.Kind != kind || now.After(c.Expires) {
		return nil, false
	}
	return c, true
}
