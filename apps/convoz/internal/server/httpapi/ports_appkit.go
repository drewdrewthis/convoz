package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// appPort is the check of the app a message carries, run inside the post's transaction (the appkit module).
type appPort struct{}

func (appPort) ValidateApp(ctx context.Context, d pdb.DBTX, author int64, raw []byte) error {
	_, err := appkit.Check(ctx, d, uploadFiles{}, author, raw)
	return err
}

// uploadFiles lets an app check read the uploads it names.
type uploadFiles struct{}

func (uploadFiles) Find(ctx context.Context, d pdb.DBTX, id string) (appkit.File, bool, error) {
	r, ok, err := upload.ByPublicID(ctx, d, id)
	return appkit.File{Uploader: r.UploaderID, Kind: r.Kind, Complete: r.Complete(), SHA256: r.SHA256, Size: r.DeclaredSize}, ok, err
}
