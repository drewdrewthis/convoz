package httpapi

import (
	"context"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// registerPasskey hands the caller's new passkey to auth, which owns the flow.
func registerPasskey(ctx context.Context, d pdb.DBTX, c *call, cred *webauthn.Credential, now time.Time) error {
	return auth.RegisterPasskey(ctx, d, journalPort{}, auth.RegisterInput{
		Human: c.human, DeviceID: c.dev.ID, Limited: c.p.Limited, StepUpID: c.stepUp, Credential: cred,
	}, now)
}
