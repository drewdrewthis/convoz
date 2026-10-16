package auth

import (
	"context"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// ErrDeviceGone means the recovery device ended before this registration could end it: another request used
// it first. Two verifies racing on one recovery device must not both add a passkey.
var ErrDeviceGone = errors.New("the recovery device already ended")

// RegisterInput is a verified new passkey and the device that adds it.
type RegisterInput struct {
	Human      Human
	DeviceID   int64
	Limited    bool  // a recovery device: no step-up, and it ends with this registration
	StepUpID   int64 // the passkey.add step-up of a normal device
	Credential *webauthn.Credential
}

// RegisterPasskey adds a passkey to the caller inside the open transaction. A normal device spends a
// passkey.add step-up. A recovery device has no passkey to step up with, so it needs nothing more, and the
// device ends with this one registration (its passkey may not do destructive things yet). It writes the
// audit line and the event.
func RegisterPasskey(ctx context.Context, d pdb.DBTX, j JournalPort, in RegisterInput, now time.Time) error {
	via := "session"
	if in.Limited {
		via = "recovery"
	} else if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "passkey.add", nil, now); err != nil {
		return err
	}
	passkeyID, err := AddPasskey(ctx, d, in.Human.ID, in.Credential, PasskeyLabel(now), via, now)
	if err != nil {
		return err
	}
	if in.Limited {
		ended, err := RevokeDevice(ctx, d, in.Human.ID, in.DeviceID, "expired", now)
		if err != nil {
			return err
		}
		if !ended {
			return ErrDeviceGone
		}
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "passkey.added", TargetKind: "passkey", TargetID: passkeyID, Detail: map[string]any{"via": via}}); err != nil {
		return err
	}
	return j.Event(ctx, d, now, "passkey.added.v1", map[string]any{"identity_id": in.Human.ID, "passkey_id": passkeyID, "via": via})
}
