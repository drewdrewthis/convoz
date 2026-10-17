package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// bootstrapPorts wires auth's bootstrap flow to the identity, audit and event modules.
var bootstrapPorts = auth.BootstrapPorts{Owners: ownerPort{}, Journal: journalPort{}}

type ownerPort struct{}

func (ownerPort) Owner(ctx context.Context, d pdb.DBTX) (auth.Human, bool, error) {
	h, err := identity.Owner(ctx, d)
	if errors.Is(err, identity.ErrNotFound) {
		return auth.Human{}, false, nil
	}
	return humanOf(h), err == nil, err
}

func (ownerPort) CreateOwner(ctx context.Context, d pdb.DBTX, handle, displayName string, now time.Time) (auth.Human, error) {
	h, err := identity.CreateOwner(ctx, d, handle, displayName, now)
	return humanOf(h), err
}

type journalPort struct{}

func (journalPort) Audit(ctx context.Context, d pdb.DBTX, now time.Time, e auth.AuditEntry) error {
	return audit.Write(ctx, d, now, audit.Entry(e))
}

func (journalPort) Event(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload map[string]any) error {
	_, err := event.Append(ctx, d, now, typ, payload)
	return err
}

// flowPorts wires auth's machine, session and crew flows to the identity, audit and event modules.
var flowPorts = auth.Ports{Agents: agentPort{}, Journal: journalPort{}}

type agentPort struct{}

func agentOf(p identity.Principal) auth.Agent {
	return auth.Agent{ID: p.ID, Kind: p.Kind, Handle: p.Handle, DisplayName: p.DisplayName, Disabled: p.Disabled}
}

func (agentPort) ValidHandle(s string) bool { return identity.ValidHandle(s) }

func (agentPort) Lookup(ctx context.Context, d pdb.DBTX, handle string) (auth.Agent, bool, error) {
	p, found, err := identity.Lookup(ctx, d, handle)
	return agentOf(p), found, err
}

func (agentPort) Handles(ctx context.Context, d pdb.DBTX) (map[int64]string, error) {
	return identity.Handles(ctx, d)
}

func (agentPort) Create(ctx context.Context, d pdb.DBTX, in auth.NewAgent, now time.Time) (auth.Agent, error) {
	p, err := identity.CreateAgent(ctx, d, identity.NewAgent{Handle: in.Handle, DisplayName: in.DisplayName, ByHuman: in.ByHuman, ByMachine: in.ByMachine}, now)
	if err != nil {
		return auth.Agent{}, agentError(err)
	}
	return agentOf(p), nil
}

func (agentPort) Disable(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (bool, error) {
	return identity.DisableAgent(ctx, d, id, now)
}

func (agentPort) CreatedByMachineSince(ctx context.Context, d pdb.DBTX, machineID int64, since time.Time) (int64, int64, error) {
	return identity.CreatedByMachineSince(ctx, d, machineID, since)
}

// agentError turns a CreateAgent refusal into the auth error that names the field; other errors pass through.
func agentError(err error) error {
	switch {
	case errors.Is(err, identity.ErrInvalidHandle):
		return &auth.FieldError{Field: "handle", Message: "A handle has 2 to 40 characters from a-z, 0-9 and -, starts with a letter and is not reserved."}
	case errors.Is(err, identity.ErrHandleTaken):
		return auth.ErrHandleTaken
	case errors.Is(err, identity.ErrInvalidDisplayName):
		return &auth.FieldError{Field: "display_name", Message: "A display name has 1 to 80 characters."}
	case errors.Is(err, identity.ErrConfusableName):
		return &auth.FieldError{Field: "display_name", Message: "That name looks like another identity's name. Pick a different one."}
	}
	return err
}
