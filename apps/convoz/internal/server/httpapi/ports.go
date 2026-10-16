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
