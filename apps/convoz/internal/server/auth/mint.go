package auth

import (
	"context"
	"errors"
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

// CreateIdentity asks MintSession to make the agent when it does not exist. The agent sends its own identity: a machine with the
// create_identity scope that allows the handle gets it at once; any other machine files a request for the owner to approve, and asks
// again with Request (the ref it was given) until the owner decides.
type CreateIdentity struct {
	DisplayName    string
	Description    string
	AvatarSVG      string // cleaned by the caller (I-32)
	ConversationID int64
	Request        string
}

// Refusals of a session request that waits on the owner; the HTTP layer maps each to an answer.
var (
	ErrIdentityDenied  = errors.New("the owner denied the identity request")
	ErrIdentityExpired = errors.New("the identity request expired")
)

// MintSession makes a lease for a machine inside the open transaction. The machine is read again from its
// key here: a revoke or a new allow-list may have landed since the request began. It finds the agent, or
// makes it when the machine may, enforces the caps and budgets, and writes the audit line and the event.
func MintSession(ctx context.Context, d pdb.DBTX, p Ports, in MintRequest, now time.Time) (MintedSession, error) {
	if err := ValidateMint(p, in); err != nil {
		return MintedSession{}, err
	}
	machine, ok, err := MachineByKey(ctx, d, in.MachineKey)
	if err != nil {
		return MintedSession{}, err
	}
	if !ok {
		return MintedSession{}, ErrMachineGone
	}
	if in.Create != nil && in.Create.Request != "" {
		state, expires, err := PollIdentity(ctx, d, machine.ID, in.Create.Request, now)
		switch {
		case err != nil:
			return MintedSession{}, err
		case state == StatePending:
			return MintedSession{Waiting: &IdentityFiled{Ref: in.Create.Request, ExpiresAt: expires}}, nil
		case state == StateDenied:
			return MintedSession{}, ErrIdentityDenied
		case state == StateExpired:
			return MintedSession{}, ErrIdentityExpired
		}
	}
	who, filed, err := sessionIdentity(ctx, d, p, machine, in, now)
	if err != nil {
		return MintedSession{}, err
	}
	if filed != nil {
		return MintedSession{Waiting: filed}, nil
	}
	minted, err := mintLease(ctx, d, leaseInput{Machine: machine, IdentityID: who.ID, Handle: who.Handle, ClientID: in.ClientID, Label: in.Label}, now)
	if err != nil {
		return MintedSession{}, err
	}
	minted.Handle = who.Handle
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: who.ID, Machine: machine.ID, Session: minted.ID, Action: "session.started", TargetKind: "session", TargetID: minted.ID}); err != nil {
		return MintedSession{}, err
	}
	err = p.Journal.Event(ctx, d, now, "session.started.v1", map[string]any{"session_id": minted.ID, "machine_id": machine.ID, "identity_id": who.ID})
	return minted, err
}

// sessionIdentity finds the agent a mint is for. A human, a disabled identity and a handle the machine may not use are forbidden.
// With create: an existing agent the machine may act as is simply used; an existing one it may not act as is a taken handle (a
// request never takes over an identity); a missing one is made at once when the machine has the scope and allows the handle, and
// otherwise requested from the owner (filed is then set).
func sessionIdentity(ctx context.Context, d pdb.DBTX, p Ports, m Machine, in MintRequest, now time.Time) (who Agent, filed *IdentityFiled, err error) {
	handle := strings.ToLower(in.As)
	who, found, err := p.Agents.Lookup(ctx, d, handle)
	if err != nil {
		return Agent{}, nil, err
	}
	if found {
		if who.Kind != "agent" || who.Disabled {
			return Agent{}, nil, ForbiddenError("That identity cannot start a session.")
		}
		if in.Create != nil && !m.Allow.Covers(who.ID, handle) {
			return Agent{}, nil, ErrHandleTaken
		}
		return who, nil, nil
	}
	if in.Create == nil {
		return Agent{}, nil, ForbiddenError("This machine may not act as that identity.")
	}
	pkg := IdentityPackage{Handle: handle, DisplayName: in.Create.DisplayName, Description: in.Create.Description, AvatarSVG: in.Create.AvatarSVG, ConversationID: in.Create.ConversationID}
	if m.Scopes&ScopeCreateIdentity == 0 || !m.Allow.CoversHandle(handle) {
		f, err := FileSessionIdentity(ctx, d, p, m, pkg, now)
		if err != nil {
			return Agent{}, nil, err
		}
		return Agent{}, &f, nil
	}
	who, err = createForMachine(ctx, d, p, m, pkg, now)
	return who, nil, err
}

func createForMachine(ctx context.Context, d pdb.DBTX, p Ports, m Machine, pkg IdentityPackage, now time.Time) (Agent, error) {
	pkg, err := CheckIdentityPackage(ctx, d, p, pkg)
	if err != nil {
		return Agent{}, err
	}
	n, oldest, err := p.Agents.CreatedByMachineSince(ctx, d, m.ID, now.Add(-24*time.Hour))
	if err != nil {
		return Agent{}, err
	}
	if n >= CreatedPerDay {
		return Agent{}, &RateLimitedError{RetryAfter: retryAfter(oldest, 24*time.Hour, now)}
	}
	name := pkg.DisplayName
	if name == "" {
		name = pkg.Handle
	}
	who, err := p.Agents.Create(ctx, d, NewAgent{Handle: pkg.Handle, DisplayName: name, ByMachine: m.ID}, now)
	if err != nil {
		return Agent{}, err
	}
	if err := p.Agents.SetIntro(ctx, d, who.ID, pkg.Description, pkg.AvatarSVG); err != nil {
		return Agent{}, err
	}
	if pkg.ConversationID != 0 { // no person is tapping here, so the new agent asks to join and the owner decides (I-17)
		if err := p.Conversations.Join(ctx, d, now, pkg.ConversationID, who.ID, 0); err != nil {
			return Agent{}, err
		}
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Machine: m.ID, Action: "identity.created", TargetKind: "identity", TargetID: who.ID}); err != nil {
		return Agent{}, err
	}
	return who, p.Journal.Event(ctx, d, now, "identity.created.v1", map[string]any{"identity_id": who.ID, "machine_id": m.ID})
}
