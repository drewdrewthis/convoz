package httpapi

import (
	"context"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// registerPasskey adds cred to the caller inside the open transaction. A normal device spends a
// passkey.add step-up. A recovery device has no passkey to step up with, so it needs nothing more,
// and the device ends with this one registration (its passkey may not do destructive things yet).
func registerPasskey(ctx context.Context, d pdb.DBTX, c *call, cred *webauthn.Credential, now time.Time) error {
	via := "session"
	if c.p.Limited {
		via = "recovery"
	} else if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "passkey.add", nil, now); err != nil {
		return err
	}
	passkeyID, err := auth.AddPasskey(ctx, d, c.human.ID, cred, auth.PasskeyLabel(now), via, now)
	if err != nil {
		return err
	}
	if c.p.Limited {
		if _, err := auth.RevokeDevice(ctx, d, c.human.ID, c.dev.ID, "expired", now); err != nil {
			return err
		}
	}
	if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "passkey.added", TargetKind: "passkey", TargetID: passkeyID, Detail: map[string]any{"via": via}}); err != nil {
		return err
	}
	_, err = event.Append(ctx, d, now, "passkey.added", map[string]any{"identity_id": c.human.ID, "passkey_id": passkeyID, "via": via})
	return err
}
