package httpapi

import (
	"context"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// appPort validates the app a message carries. No-op until its work package lands.
type appPort struct{}

func (appPort) ValidateApp(context.Context, pdb.DBTX, int64, []byte) error { return nil }
