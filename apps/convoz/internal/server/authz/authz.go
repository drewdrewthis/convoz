// Package authz holds the principal types and the route requirement check. It owns no tables.
package authz

import "errors"

// Auth is what a route needs from the caller (design §13 letters).
type Auth int

// The auth classes of a route.
const (
	Pub          Auth = iota // no credential
	Human                    // H: a device session that is not limited
	HumanLimited             // H/L: a device session, a recovery (limited) one too
	Owner                    // O: a full device session of the owner
	Machine                  // M: a machine key (only POST /api/sessions takes one)
	Lease                    // L: a session lease of an agent
)

// String is the letter used in the route table.
func (a Auth) String() string {
	return [...]string{"pub", "H", "H/L", "O", "M", "L"}[a]
}

// Principal is who a request is from. The zero value is anonymous. A person has Authenticated set (a device
// session); a machine key sets MachineID and a lease sets SessionID, never together.
type Principal struct {
	Authenticated bool
	HumanID       int64
	DeviceID      int64
	Limited       bool
	Role          string
	MachineID     int64
	SessionID     int64
}

// Errors Check returns; the HTTP layer maps them to 401 and 403.
var (
	ErrUnauthorized = errors.New("sign in required")
	ErrLimited      = errors.New("this device may only register a passkey")
	ErrForbidden    = errors.New("not allowed")
)

// Check reports whether p meets a route's requirement. A machine key or a lease never meets a person's route.
func (a Auth) Check(p Principal) error {
	switch a {
	case Pub:
		return nil
	case Machine:
		if p.MachineID == 0 {
			return ErrUnauthorized
		}
		return nil
	case Lease:
		if p.SessionID == 0 {
			return ErrUnauthorized
		}
		return nil
	}
	if !p.Authenticated {
		return ErrUnauthorized
	}
	if p.Limited && a != HumanLimited {
		return ErrLimited
	}
	if a == Owner && p.Role != "owner" {
		return ErrForbidden
	}
	return nil
}
