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
	TypedCode string
	Human     Human
	DeviceID  int64
	StepUpID  int64
}

// ApproveRequest turns a pending request into a machine inside the open transaction: it spends the
// machine.approve step-up, checks the typed code when more than one request waits, checks the name and the
// cap, makes the machine, marks the request approved, and writes the audit line and the event.
func ApproveRequest(ctx context.Context, d pdb.DBTX, box *KeyBox, p Ports, in ApproveInput, now time.Time) (Machine, error) {
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.approve", &in.RequestID, now); err != nil {
		return Machine{}, err
	}
	req, err := PendingRequest(ctx, d, in.RequestID, now)
	if err != nil {
		return Machine{}, err
	}
	waiting, err := CountPendingRequests(ctx, d, now)
	if err != nil {
		return Machine{}, err
	}
	if waiting > 1 && in.TypedCode != req.UserCode {
		return Machine{}, ErrCodeMismatch
	}
	name := in.Name
	if name == "" {
		name = req.Name
	}
	// The name and the cap come before the allow-list: a refusal for either needs no handle to exist.
	if err := CheckMachineSlot(ctx, d, name); err != nil {
		return Machine{}, nameTaken(err, name)
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
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: machineID, Action: "machine.approved", TargetKind: "machine", TargetID: machineID, Detail: map[string]any{"request_id": in.RequestID}}); err != nil {
		return Machine{}, err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.approved.v1", map[string]any{"machine_id": machineID, "request_id": in.RequestID}); err != nil {
		return Machine{}, err
	}
	return MachineByID(ctx, d, machineID, now)
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
// working on other machines), and writes the audit line and the event.
func ReplaceMachineAllow(ctx context.Context, d pdb.DBTX, p Ports, in AllowChange, now time.Time) (Machine, error) {
	id := in.MachineID
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.allow", &id, now); err != nil {
		return Machine{}, err
	}
	if _, err := MachineByID(ctx, d, id, now); err != nil {
		return Machine{}, err
	}
	allow, err := ResolveAllow(ctx, d, p.Agents, in.Allow)
	if err != nil {
		return Machine{}, err
	}
	if err := endUncovered(ctx, d, p.Agents, id, allow, now); err != nil {
		return Machine{}, err
	}
	if err := ReplaceAllow(ctx, d, id, allow); err != nil {
		return Machine{}, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: id, Action: "machine.allow_changed", TargetKind: "machine", TargetID: id}); err != nil {
		return Machine{}, err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.allow_changed.v1", map[string]any{"machine_id": id}); err != nil {
		return Machine{}, err
	}
	return MachineByID(ctx, d, id, now)
}

func endUncovered(ctx context.Context, d pdb.DBTX, agents AgentPort, machineID int64, next Allow, now time.Time) error {
	live, err := LiveSessionIdentities(ctx, d, machineID, now)
	if err != nil || len(live) == 0 {
		return err
	}
	handles, err := agents.Handles(ctx, d)
	if err != nil {
		return err
	}
	for _, identityID := range live {
		if next.Covers(identityID, handles[identityID]) {
			continue
		}
		if err := EndMachineIdentitySessions(ctx, d, machineID, identityID, "allow_removed", now); err != nil {
			return err
		}
	}
	return nil
}
