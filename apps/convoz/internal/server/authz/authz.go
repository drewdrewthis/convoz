// Package authz holds the principal types and the route requirement check. It owns no tables.
package authz

import (
	"context"
	"errors"
)

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
	IdentityID    int64 // the agent a lease acts as; 0 for everything else
	LeaseMachine  int64 // the machine behind a lease, for the audit trail (I-40); no route check reads it, so a lease never meets a machine route
}

// Identity is the identity the caller speaks as: the person for a device session, the agent for a lease, 0 otherwise.
func (p Principal) Identity() int64 {
	if p.SessionID != 0 {
		return p.IdentityID
	}
	return p.HumanID
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

// Member is one identity's standing in one conversation.
type Member struct {
	Active          bool
	JoinedMessageID int64 // 0 = all history; every member has 0 (owner msg 143, migration 0028)
}

// ParticipantReader is the port canSee needs. The composition root implements it over the conversation module.
type ParticipantReader interface {
	Membership(ctx context.Context, conversationID, identityID int64) (Member, bool, error)
}

// CanSee is the one visibility rule (design §2.3): the owner sees every conversation, anyone else only one where
// it is an active participant, and with the whole history (owner, msg 143: "History should be accessible yes"). floor is the highest message
// id the caller may NOT see: 0 for every member now; read paths still pass it down to the message queries.
func CanSee(ctx context.Context, r ParticipantReader, p Principal, conversationID int64) (floor int64, ok bool, err error) {
	if p.Authenticated && p.Role == "owner" {
		return 0, true, nil
	}
	who := p.Identity()
	if who == 0 {
		return 0, false, nil
	}
	m, found, err := r.Membership(ctx, conversationID, who)
	if err != nil || !found || !m.Active {
		return 0, false, err
	}
	return m.JoinedMessageID, true, nil
}

// TriageReader is what CanRead needs: membership, and whether the conversation is open to a triage agent.
type TriageReader interface {
	ParticipantReader
	// IsTriage says whether identityID is an agent with the triage right and conversationID is a live (not trashed) conversation.
	IsTriage(ctx context.Context, conversationID, identityID int64) (bool, error)
}

// CanRead is CanSee plus the triage right (owner, msgs 784 and 1217): a triage agent reads every live conversation without being a
// participant, whole history. Only read paths, posting a message and CanManageAgents use it; every other act on a conversation stays
// CanSee, so the right is looked up per call and a revoke takes effect on the next request or stream frame.
func CanRead(ctx context.Context, r TriageReader, p Principal, conversationID int64) (floor int64, ok bool, err error) {
	if floor, ok, err = CanSee(ctx, r, p, conversationID); err != nil || ok || p.SessionID == 0 {
		return floor, ok, err
	}
	granted, err := r.IsTriage(ctx, conversationID, p.IdentityID)
	return 0, granted, err
}

// CanManageAgents says whether p may add or remove agents in a conversation (owner, msg 1217: "triage agents can also add and remove
// agents to chats ... it can add itself to a chat"): a participant, the owner, or a triage agent in a live conversation. What it may do
// with that is the handler's: a plain agent still only asks, and nobody removes the owner or a person.
func CanManageAgents(ctx context.Context, r TriageReader, p Principal, conversationID int64) (bool, error) {
	_, ok, err := CanRead(ctx, r, p, conversationID)
	return ok, err
}
