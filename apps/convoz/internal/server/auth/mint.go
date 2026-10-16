package auth

import (
	"context"
	"strings"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// CreatedPerDay is how many identities one machine may make in 24 hours.
const CreatedPerDay = 5

// MintRequest is what a machine asks for: a lease as one agent.
type MintRequest struct {
	MachineKey string
	As         string
	ClientID   string
	Label      string
	Create     *CreateIdentity // make the agent when there is none
}

// CreateIdentity asks MintSession to make the agent when it does not exist.
type CreateIdentity struct{ DisplayName string }

// MintSession makes a lease for a machine inside the open transaction. The machine is read again from its
// key here: a revoke or a new allow-list may have landed since the request began. It finds the agent, or
// makes it when the machine may, enforces the caps and budgets, and writes the audit line and the event.
func MintSession(ctx context.Context, d pdb.DBTX, p Ports, in MintRequest, now time.Time) (MintedSession, error) {
	machine, ok, err := MachineByKey(ctx, d, in.MachineKey)
	if err != nil {
		return MintedSession{}, err
	}
	if !ok {
		return MintedSession{}, ErrMachineGone
	}
	who, err := sessionIdentity(ctx, d, p, machine, in, now)
	if err != nil {
		return MintedSession{}, err
	}
	minted, err := mintLease(ctx, d, leaseInput{Machine: machine, IdentityID: who.ID, Handle: who.Handle, ClientID: in.ClientID, Label: in.Label}, now)
	if err != nil {
		return MintedSession{}, err
	}
	minted.Handle = who.Handle
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: who.ID, Machine: machine.ID, Session: minted.ID, Action: "session.started", TargetKind: "session", TargetID: minted.ID}); err != nil {
		return MintedSession{}, err
	}
	err = p.Journal.Event(ctx, d, now, "session.started", map[string]any{"session_id": minted.ID, "machine_id": machine.ID, "identity_id": who.ID})
	return minted, err
}

// sessionIdentity finds the agent a mint is for, or makes it when the machine may. A human, a disabled
// identity and a handle the machine may not use are all forbidden; so is "create" without the scope.
func sessionIdentity(ctx context.Context, d pdb.DBTX, p Ports, m Machine, in MintRequest, now time.Time) (Agent, error) {
	if in.Create != nil && m.Scopes&ScopeCreateIdentity == 0 {
		return Agent{}, ForbiddenError("This machine may not make identities.")
	}
	handle := strings.ToLower(in.As)
	who, found, err := p.Agents.Lookup(ctx, d, handle)
	if err != nil {
		return Agent{}, err
	}
	if !found {
		if in.Create == nil || !m.Allow.CoversHandle(handle) {
			return Agent{}, ForbiddenError("This machine may not act as that identity.")
		}
		return createForMachine(ctx, d, p, m, handle, in.Create.DisplayName, now)
	}
	if who.Kind != "agent" || who.Disabled {
		return Agent{}, ForbiddenError("That identity cannot start a session.")
	}
	return who, nil
}

func createForMachine(ctx context.Context, d pdb.DBTX, p Ports, m Machine, handle, displayName string, now time.Time) (Agent, error) {
	n, oldest, err := p.Agents.CreatedByMachineSince(ctx, d, m.ID, now.Add(-24*time.Hour))
	if err != nil {
		return Agent{}, err
	}
	if n >= CreatedPerDay {
		return Agent{}, &RateLimitedError{RetryAfter: retryAfter(oldest, 24*time.Hour, now)}
	}
	who, err := p.Agents.Create(ctx, d, NewAgent{Handle: handle, DisplayName: displayName, ByMachine: m.ID}, now)
	if err != nil {
		return Agent{}, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Machine: m.ID, Action: "identity.created", TargetKind: "identity", TargetID: who.ID}); err != nil {
		return Agent{}, err
	}
	return who, p.Journal.Event(ctx, d, now, "identity.created", map[string]any{"identity_id": who.ID, "machine_id": m.ID})
}
