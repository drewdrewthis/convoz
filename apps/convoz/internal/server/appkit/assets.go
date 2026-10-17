package appkit

import (
	"context"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MaxImageBytes is the largest gallery image an app may name.
const MaxImageBytes = 5 << 20

// Kinds of upload an app points at: the files live in the upload module (two phases, bound once to the app's message).
const (
	KindBundle = "app"
	KindImage  = "image"
)

// File is an upload as an app check sees it.
type File struct {
	Uploader int64
	Kind     string
	Complete bool
	SHA256   []byte
	Size     int64
}

// Files is the port to the uploads, declared here and implemented by the caller.
type Files interface {
	// Find reads an upload by the public id an app names; ok is false when there is none.
	Find(ctx context.Context, d pdb.DBTX, id string) (f File, ok bool, err error)
}
