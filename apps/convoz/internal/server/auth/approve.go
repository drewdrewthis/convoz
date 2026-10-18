package auth

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// maxAllowEntries bounds an allow-list so a request cannot make a huge one.
const maxAllowEntries = 100

// AllowSpec is an allow-list as the owner writes it: handles and globs, not ids.
type AllowSpec struct {
	Mode       string
	Identities []string
	Globs      []string
}

// ResolveAllow turns handles into agent ids. A handle that is not an agent, and a glob that cannot be
// stored, are refused with a BadAllowError.
func ResolveAllow(ctx context.Context, d pdb.DBTX, agents AgentPort, in AllowSpec) (Allow, error) {
	switch in.Mode {
	case AllowAny:
		return Allow{Mode: AllowAny}, nil
	case AllowList:
	default:
		return Allow{}, BadAllowError(`The allow-list mode must be "list" or "any".`)
	}
	if len(in.Identities)+len(in.Globs) > maxAllowEntries {
		return Allow{}, BadAllowError("The allow-list is too long.")
	}
	out := Allow{Mode: AllowList}
	for _, h := range in.Identities {
		a, found, err := agents.Lookup(ctx, d, h)
		if err != nil {
			return Allow{}, err
		}
		if !found || a.Kind != "agent" {
			return Allow{}, BadAllowError(fmt.Sprintf("There is no agent %q.", h))
		}
		if !slices.Contains(out.IdentityIDs, a.ID) {
			out.IdentityIDs = append(out.IdentityIDs, a.ID)
		}
	}
	for _, g := range in.Globs {
		if !ValidGlob(g) {
			return Allow{}, BadAllowError(fmt.Sprintf("The pattern %q can only hold a-z, 0-9, -, * and ?.", g))
		}
		if !slices.Contains(out.Globs, g) {
			out.Globs = append(out.Globs, g)
		}
	}
	return out, nil
}

// MachineByID finds one active machine.
func MachineByID(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (Machine, error) {
	list, err := ListMachines(ctx, d, now)
	if err != nil {
		return Machine{}, err
	}
	for _, m := range list {
		if m.ID == id {
			return m, nil
		}
	}
	return Machine{}, ErrNoMachine
}

// ApproveInput is the owner's decision on one pending request.
type ApproveInput struct {
	RequestID int64
	Name      string // empty: the name the machine asked for
	Allow     AllowSpec
	Scopes    int64
	Human     Human
	DeviceID  int64
}

// ApproveRequest turns a pending request into a machine inside the open transaction: it checks the name and the cap, makes the
// machine, marks the request approved, and writes the audit line and the event. The owner's signed-in session is the authority
// (owner said: "Approvals just go into the feed, right?"): no passkey check and no typed code. A request that carries an identity
// also makes that agent and lets the new machine act as it.
func ApproveRequest(ctx context.Context, d pdb.DBTX, box *KeyBox, p Ports, in ApproveInput, now time.Time) (Machine, error) {
	req, err := PendingRequest(ctx, d, in.RequestID, now)
	if err != nil {
		return Machine{}, err
	}
	name := in.Name
	if name == "" {
		name = req.Name
	}
	// The name and the cap come before the allow-list: a refusal for either needs no handle to exist.
	if err := freeMachineSlot(ctx, d, p, in, name, now); err != nil {
		return Machine{}, nameTaken(err, name)
	}
	idReq, carries, err := loginIdentityOf(ctx, d, in.RequestID)
	if err != nil {
		return Machine{}, err
	}
	if in.Allow.Mode == "" {
		in.Allow.Mode = AllowList // one tap names no allow-list: an empty list (or just the new identity), widened later in Crew
	}
	allow, err := ResolveAllow(ctx, d, p.Agents, in.Allow)
	if err != nil {
		return Machine{}, err
	}
	machineID, err := CreateMachine(ctx, d, box, NewMachine{Name: name, Scopes: in.Scopes, Allow: allow, ApprovedBy: in.Human.ID}, now)
	if err != nil {
		return Machine{}, nameTaken(err, name)
	}
	if err := MarkApproved(ctx, d, in.RequestID, machineID, in.Human.ID, now); err != nil {
		return Machine{}, err
	}
	if carries {
		made, err := makeRequestedIdentity(ctx, d, p, in.Human, machineID, idReq.ID, now)
		if err != nil {
			return Machine{}, err
		}
		if err := addToAllow(ctx, d, machineID, made.ID, now); err != nil {
			return Machine{}, err
		}
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: machineID, Action: "machine.approved", TargetKind: "machine", TargetID: machineID, Detail: map[string]any{"request_id": in.RequestID}}); err != nil {
		return Machine{}, err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.approved.v1", map[string]any{"machine_id": machineID, "request_id": in.RequestID}); err != nil {
		return Machine{}, err
	}
	return MachineByID(ctx, d, machineID, now)
}

// freeMachineSlot is CheckMachineSlot that first retires an active machine of the same name when nothing active depends on it: it
// serves no enabled agent (a revoked agent's old box asking again under its own name). The old machine is revoked in this
// transaction, so a failed approval leaves it as it was. A machine that still serves an enabled agent keeps the name.
func freeMachineSlot(ctx context.Context, d pdb.DBTX, p Ports, in ApproveInput, name string, now time.Time) error {
	err := CheckMachineSlot(ctx, d, name)
	if !errors.Is(err, ErrNameTaken) {
		return err
	}
	old, id, found, err := idleMachineNamed(ctx, d, p, name, now)
	if err != nil {
		return err
	}
	if !found {
		return ErrNameTaken
	}
	if _, _, err := RevokeMachine(ctx, d, id, now); err != nil {
		return err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: old.ID, Action: "machine.replaced", TargetKind: "machine", TargetID: old.ID, Detail: map[string]any{"request_id": in.RequestID}}); err != nil {
		return err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.revoked.v1", map[string]any{"machine_id": old.ID}); err != nil {
		return err
	}
	return CheckMachineSlot(ctx, d, name)
}

// idleMachineNamed finds the active machine called name when it can be retired: its allow-list names only agents that are all
// disabled, or none. A machine that allows any agent, or a glob, may serve an agent nobody named yet, so it keeps its name.
func idleMachineNamed(ctx context.Context, d pdb.DBTX, p Ports, name string, now time.Time) (Machine, int64, bool, error) {
	list, err := ListMachines(ctx, d, now)
	if err != nil {
		return Machine{}, 0, false, err
	}
	active, err := p.Agents.ActiveAgents(ctx, d)
	if err != nil {
		return Machine{}, 0, false, err
	}
	for _, m := range list {
		if m.Name != name {
			continue
		}
		if m.Allow.Mode == AllowAny || len(m.Allow.Globs) > 0 {
			return Machine{}, 0, false, nil
		}
		for _, id := range m.Allow.IdentityIDs {
			if _, enabled := active[id]; enabled {
				return Machine{}, 0, false, nil
			}
		}
		return m, m.ID, true, nil
	}
	return Machine{}, 0, false, nil
}

func nameTaken(err error, name string) error {
	if errors.Is(err, ErrNameTaken) {
		return &NameTakenError{Name: name}
	}
	return err
}

// AllowChange is the owner's new allow-list for one machine.
type AllowChange struct {
	MachineID int64
	Allow     AllowSpec
	Human     Human
	DeviceID  int64
	StepUpID  int64
}

// ReplaceMachineAllow swaps a machine's allow-list inside the open transaction. It spends the machine.allow
// step-up, ends the machine's leases for every identity the new list does not cover (the same identity keeps
// working on other machines), and writes the audit line and the event. The ids of the ended leases come back.
func ReplaceMachineAllow(ctx context.Context, d pdb.DBTX, p Ports, in AllowChange, now time.Time) (Machine, []int64, error) {
	id := in.MachineID
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.allow", &id, now); err != nil {
		return Machine{}, nil, err
	}
	if _, err := MachineByID(ctx, d, id, now); err != nil {
		return Machine{}, nil, err
	}
	allow, err := ResolveAllow(ctx, d, p.Agents, in.Allow)
	if err != nil {
		return Machine{}, nil, err
	}
	ended, err := endUncovered(ctx, d, p.Agents, id, allow, now)
	if err != nil {
		return Machine{}, nil, err
	}
	if err := ReplaceAllow(ctx, d, id, allow); err != nil {
		return Machine{}, nil, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: id, Action: "machine.allow_changed", TargetKind: "machine", TargetID: id}); err != nil {
		return Machine{}, nil, err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.allow_changed.v1", map[string]any{"machine_id": id}); err != nil {
		return Machine{}, nil, err
	}
	m, err := MachineByID(ctx, d, id, now)
	return m, ended, err
}

func endUncovered(ctx context.Context, d pdb.DBTX, agents AgentPort, machineID int64, next Allow, now time.Time) ([]int64, error) {
	live, err := LiveSessionIdentities(ctx, d, machineID, now)
	if err != nil || len(live) == 0 {
		return nil, err
	}
	handles, err := agents.Handles(ctx, d)
	if err != nil {
		return nil, err
	}
	var ended []int64
	for _, identityID := range live {
		if next.Covers(identityID, handles[identityID]) {
			continue
		}
		ids, err := EndMachineIdentitySessions(ctx, d, machineID, identityID, "allow_removed", now)
		if err != nil {
			return nil, err
		}
		ended = append(ended, ids...)
	}
	return ended, nil
}
