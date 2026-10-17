package appkit

import (
	"context"
	"encoding/hex"
	"fmt"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Check judges an app before anything is written: the schema and the semantic checks, then the files it points at (I-50). The
// error it returns, if any, is an *appschema.Issue. The app it returns carries the compact JSON to store.
func Check(ctx context.Context, d pdb.DBTX, files Files, author int64, raw []byte) (*appschema.App, error) {
	a, issue := appschema.Check(raw)
	if issue != nil {
		return nil, issue
	}
	if issue, err := checkRefs(ctx, d, files, author, a.Refs()); err != nil || issue != nil {
		if issue != nil {
			return nil, issue
		}
		return nil, err
	}
	return a, nil
}

func checkRefs(ctx context.Context, d pdb.DBTX, files Files, author int64, refs appschema.Refs) (*appschema.Issue, error) {
	for i, id := range refs.Images {
		at := fmt.Sprintf("/props/images/%d/upload", i)
		if issue, err := checkAsset(ctx, d, files, author, id, KindImage, at); err != nil || issue != nil {
			return issue, err
		}
	}
	if b := refs.Bundle; b != nil {
		const at = "/props/bundle/upload"
		if issue, err := checkAsset(ctx, d, files, author, b.Upload, KindBundle, at); err != nil || issue != nil {
			return issue, err
		}
		a, _, err := files.Find(ctx, d, b.Upload)
		if err != nil {
			return nil, err
		}
		if hex.EncodeToString(a.SHA256) != b.SHA256 || a.Size != b.Size {
			return &appschema.Issue{Code: "app_bundle_hash_mismatch", Path: "/props/bundle/sha256", Rule: "bundle", Message: "does not match the stored bundle"}, nil
		}
	}
	return nil, nil
}

// UploadIDs lists the uploads an app names, once each: the post binds them to its message.
func UploadIDs(a *appschema.App) []string {
	refs := a.Refs()
	seen := map[string]bool{}
	var ids []string
	for _, id := range refs.Images {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if refs.Bundle != nil && !seen[refs.Bundle.Upload] {
		ids = append(ids, refs.Bundle.Upload)
	}
	return ids
}

// checkAsset: the upload exists and is complete, the author sent it and it is the right kind. That it is bound once, to this
// message, is the post's work (upload.Bind).
func checkAsset(ctx context.Context, d pdb.DBTX, files Files, author int64, id, kind, at string) (*appschema.Issue, error) {
	a, ok, err := files.Find(ctx, d, id)
	switch {
	case err != nil:
		return nil, err
	case !ok || a.Uploader != author || !a.Complete:
		return &appschema.Issue{Code: "app_upload_not_bound", Path: at, Rule: "upload", Message: "is not a file you sent"}, nil
	case a.Kind != kind:
		return &appschema.Issue{Code: "app_upload_wrong_kind", Path: at, Rule: "upload", Message: "is not a file of the right kind"}, nil
	case kind == KindImage && a.Size > MaxImageBytes:
		return &appschema.Issue{Code: appschema.CodeTooLarge, Path: at, Rule: "size", Message: "an image has at most 5 MB"}, nil
	}
	return nil, nil
}
