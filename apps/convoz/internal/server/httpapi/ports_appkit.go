package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// appPort is the check of the app a message carries, run inside the post's transaction (the appkit module).
type appPort struct{}

func (appPort) ValidateApp(ctx context.Context, d pdb.DBTX, author int64, raw []byte) error {
	_, err := appkit.Check(ctx, d, author, raw)
	return err
}
