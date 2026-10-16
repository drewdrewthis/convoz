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
	PasskeyID  int64 // the passkey the calling device signed in with; 0 for a recovery device
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
// passkey may not do destructive things yet). A passkey added from a device whose own passkey is still held is
// held until the same time. It writes the audit lines and the event.
func RegisterPasskey(ctx context.Context, d pdb.DBTX, j JournalPort, in RegisterInput, now time.Time) (RegisterResult, error) {
	via := "session"
	if in.Limited {
		via = "recovery"
	} else if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "passkey.add", nil, now); err != nil {
		return RegisterResult{}, err
	}
	res := RegisterResult{}
	heldUntil, err := callerHold(ctx, d, in, now)
	if err != nil {
		return res, err
	}
	if res.PasskeyID, err = AddPasskey(ctx, d, in.Human.ID, in.Credential, PasskeyLabel(now), via, heldUntil, now); err != nil {
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
		var deviceID int64
		if res.DeviceToken, deviceID, err = StartDevice(ctx, d, in.Human.ID, res.PasskeyID, in.UserAgent, false, now); err != nil {
			return res, err
		}
		if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: deviceID, Action: "device.login", TargetKind: "passkey", TargetID: res.PasskeyID, Detail: map[string]any{"via": "recovery"}}); err != nil {
			return res, err
		}
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "passkey.added", TargetKind: "passkey", TargetID: res.PasskeyID, Detail: map[string]any{"via": via}}); err != nil {
		return res, err
	}
	return res, j.Event(ctx, d, now, "passkey.added", map[string]any{"identity_id": in.Human.ID, "passkey_id": res.PasskeyID, "via": via})
}

// callerHold is when the calling device's passkey may first do destructive things (unix ms); 0 when it may now.
func callerHold(ctx context.Context, d pdb.DBTX, in RegisterInput, now time.Time) (int64, error) {
	if in.Limited || in.PasskeyID == 0 {
		return 0, nil
	}
	k, ok, err := ActivePasskey(ctx, d, in.Human.ID, in.PasskeyID)
	if err != nil {
		return 0, err
	}
	if ok && k.DestructiveAt > now.UnixMilli() {
		return k.DestructiveAt, nil
	}
	return 0, nil
}
