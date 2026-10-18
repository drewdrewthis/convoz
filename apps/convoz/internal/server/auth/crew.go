package auth

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// CrewInput is an owner action on the crew: who does it and the step-up that allows it.
type CrewInput struct {
	Human    Human
	DeviceID int64
	StepUpID int64
}

// NewCrewAgent is the owner's request for a new agent.
type NewCrewAgent struct {
	CrewInput
	Handle      string
	DisplayName string
}

// CreateAgent makes an agent for the owner inside the open transaction: it spends the identity.create
// step-up and writes the audit line and the event.
func CreateAgent(ctx context.Context, d pdb.DBTX, p Ports, in NewCrewAgent, now time.Time) (Agent, error) {
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "identity.create", nil, now); err != nil {
		return Agent{}, err
	}
	made, err := p.Agents.Create(ctx, d, NewAgent{Handle: in.Handle, DisplayName: in.DisplayName, ByHuman: in.Human.ID}, now)
	if err != nil {
		return Agent{}, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "identity.created", TargetKind: "identity", TargetID: made.ID}); err != nil {
		return Agent{}, err
	}
	return made, p.Journal.Event(ctx, d, now, "identity.created.v1", map[string]any{"identity_id": made.ID})
}

// DisableAgent turns an agent off inside the open transaction and ends all its leases on every machine; their ids
// come back as ended. It returns ErrNoAgent when there is no such enabled agent.
func DisableAgent(ctx context.Context, d pdb.DBTX, p Ports, in CrewInput, agentID int64, now time.Time) ([]int64, error) {
	disabled, err := p.Agents.Disable(ctx, d, agentID, now)
	if err != nil {
		return nil, err
	}
	if !disabled {
		return nil, ErrNoAgent
	}
	ended, err := EndIdentitySessions(ctx, d, agentID, "identity_disabled", now)
	if err != nil {
		return nil, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "identity.disabled", TargetKind: "identity", TargetID: agentID}); err != nil {
		return nil, err
	}
	return ended, p.Journal.Event(ctx, d, now, "identity.disabled.v1", map[string]any{"identity_id": agentID})
}
