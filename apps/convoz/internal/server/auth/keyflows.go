package auth

import (
	"context"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MachineAction is an owner action on one machine: who does it, the step-up that allows it and the machine.
type MachineAction struct {
	CrewInput
	MachineID int64
}

// RevealMachineKey spends a machine.reveal step-up and returns the key, inside the open transaction. The audit
// line and the event name the machine and never the key.
func RevealMachineKey(ctx context.Context, d pdb.DBTX, box *KeyBox, j JournalPort, in MachineAction, now time.Time) (string, error) {
	id := in.MachineID
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.reveal", &id, now); err != nil {
		return "", err
	}
	key, err := RevealKey(ctx, d, box, id)
	if err != nil {
		return "", err
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: id, Action: "machine.key_revealed", TargetKind: "machine", TargetID: id}); err != nil {
		return "", err
	}
	return key, j.Event(ctx, d, now, "machine.key_revealed.v1", map[string]any{"machine_id": id})
}

// RegenerateMachineKey spends a machine.regenerate step-up and replaces the key; its leases end at once.
func RegenerateMachineKey(ctx context.Context, d pdb.DBTX, box *KeyBox, j JournalPort, in MachineAction, now time.Time) (key string, version int64, err error) {
	id := in.MachineID
	if err = ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.regenerate", &id, now); err != nil {
		return "", 0, err
	}
	if key, version, err = RegenerateKey(ctx, d, box, id, now); err != nil {
		return "", 0, err
	}
	if err = j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: id, Action: "machine.key_regenerated", TargetKind: "machine", TargetID: id, Detail: map[string]any{"key_version": version}}); err != nil {
		return "", 0, err
	}
	return key, version, j.Event(ctx, d, now, "machine.key_regenerated.v1", map[string]any{"machine_id": id, "key_version": version})
}

// RevokeMachineByOwner spends a machine.revoke step-up and ends the machine; ErrNoMachine when it was not active.
func RevokeMachineByOwner(ctx context.Context, d pdb.DBTX, j JournalPort, in MachineAction, now time.Time) error {
	id := in.MachineID
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "machine.revoke", &id, now); err != nil {
		return err
	}
	revoked, err := RevokeMachine(ctx, d, id, now)
	if err != nil {
		return err
	}
	if !revoked {
		return ErrNoMachine
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: id, Action: "machine.revoked", TargetKind: "machine", TargetID: id}); err != nil {
		return err
	}
	return j.Event(ctx, d, now, "machine.revoked.v1", map[string]any{"machine_id": id})
}

// DenyMachineRequest denies one pending request and writes the audit line; ok is false when it was not pending.
func DenyMachineRequest(ctx context.Context, d pdb.DBTX, j JournalPort, human Human, deviceID, requestID int64, now time.Time) (bool, error) {
	denied, err := DenyRequest(ctx, d, requestID, human.ID, now)
	if err != nil || !denied {
		return false, err
	}
	return true, j.Audit(ctx, d, now, AuditEntry{Actor: human.ID, Device: deviceID, Action: "machine.denied", TargetKind: "machine_request", TargetID: requestID})
}

// DenyAllMachineRequests denies every pending request, writes one audit line when any were denied and returns the count.
func DenyAllMachineRequests(ctx context.Context, d pdb.DBTX, j JournalPort, human Human, deviceID int64, now time.Time) (int64, error) {
	n, err := DenyAllRequests(ctx, d, human.ID, now)
	if err != nil || n == 0 {
		return 0, err
	}
	return n, j.Audit(ctx, d, now, AuditEntry{Actor: human.ID, Device: deviceID, Action: "machine.denied", TargetKind: "machine_request", Detail: map[string]any{"count": n}})
}

// EndOwnLease ends the caller's own lease (reason "logout") and writes the audit line.
func EndOwnLease(ctx context.Context, d pdb.DBTX, j JournalPort, l Lease, now time.Time) error {
	if _, err := EndLease(ctx, d, l.SessionID, "logout", now); err != nil {
		return err
	}
	return j.Audit(ctx, d, now, AuditEntry{Actor: l.IdentityID, Machine: l.MachineID, Session: l.SessionID, Action: "session.ended", TargetKind: "session", TargetID: l.SessionID, Detail: map[string]any{"reason": "logout"}})
}

// ValidateMint checks the fields of a session request; the answer is a *FieldError naming the field.
func ValidateMint(p Ports, in MintRequest) error {
	switch {
	case !p.Agents.ValidHandle(strings.ToLower(in.As)):
		return &FieldError{Field: "as", Message: "The identity must be a handle."}
	case !ValidClientID(in.ClientID):
		return &FieldError{Field: "client_id", Message: "The client id must be 8 to 64 characters without spaces."}
	case !validLabel(in.Label):
		return &FieldError{Field: "label", Message: "The label can have at most 80 characters."}
	}
	return nil
}

// ValidClientID is 8 to 64 printable characters.
func ValidClientID(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 8 && n <= 64 && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}

func validLabel(s string) bool {
	return utf8.RuneCountInString(s) <= 80 && !strings.ContainsFunc(s, unicode.IsControl)
}
