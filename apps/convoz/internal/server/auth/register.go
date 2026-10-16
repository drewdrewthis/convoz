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
	UserAgent  string
	Credential *webauthn.Credential
}

// RegisterResult is what a registration leaves: the new passkey and, after recovery, the full device session
// that replaces the recovery device (empty token otherwise; the caller's device carries on).
type RegisterResult struct {
	PasskeyID   int64
	DeviceToken string
}

// RegisterPasskey adds a passkey to the caller inside the open transaction. A normal device spends a
// passkey.add step-up. A recovery device has no passkey to step up with, so it needs nothing more, and the
// device ends with this one registration and a full device session for the new passkey takes its place (the
// passkey may not do destructive things yet). It writes the audit line and the event.
func RegisterPasskey(ctx context.Context, d pdb.DBTX, j JournalPort, in RegisterInput, now time.Time) (RegisterResult, error) {
	via := "session"
	if in.Limited {
		via = "recovery"
	} else if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "passkey.add", nil, now); err != nil {
		return RegisterResult{}, err
	}
	res := RegisterResult{}
	var err error
	if res.PasskeyID, err = AddPasskey(ctx, d, in.Human.ID, in.Credential, PasskeyLabel(now), via, now); err != nil {
		return res, err
	}
	if in.Limited {
		ended, err := RevokeDevice(ctx, d, in.Human.ID, in.DeviceID, "expired", now)
		if err != nil {
			return res, err
		}
		if !ended {
			return res, ErrDeviceGone
		}
		if res.DeviceToken, _, err = StartDevice(ctx, d, in.Human.ID, res.PasskeyID, in.UserAgent, false, now); err != nil {
			return res, err
		}
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "passkey.added", TargetKind: "passkey", TargetID: res.PasskeyID, Detail: map[string]any{"via": via}}); err != nil {
		return res, err
	}
	return res, j.Event(ctx, d, now, "passkey.added", map[string]any{"identity_id": in.Human.ID, "passkey_id": res.PasskeyID, "via": via})
}
