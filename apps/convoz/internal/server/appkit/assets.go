package appkit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MaxImageBytes is the largest gallery image the stand-in store keeps.
const MaxImageBytes = 5 << 20

// Kinds of a stored asset.
const (
	KindBundle = "app"
	KindImage  = "image"
)

// Asset is a stored file an app points at. This store stands in for the upload module until kind `app` and `image` uploads carry
// these files (migration 0018); the ports of this package are what the swap changes.
type Asset struct {
	ID       string
	Uploader int64
	Kind     string
	Mime     string
	SHA256   string
	Size     int64
	Content  []byte
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func fingerprint(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// PutBundle keeps a Tier-2 bundle: one UTF-8 HTML document of at most 524288 bytes. An over-size or malformed one is an issue
// (code app_too_large or app_bundle_invalid), not an error.
func PutBundle(ctx context.Context, d pdb.DBTX, now time.Time, uploader int64, content []byte) (Asset, *appschema.Issue, error) {
	switch {
	case len(content) > appschema.MaxBundleBytes:
		return Asset{}, &appschema.Issue{Code: appschema.CodeTooLarge, Rule: "size", Message: "a bundle has at most 524288 bytes"}, nil
	case len(content) == 0 || !utf8.Valid(content):
		return Asset{}, &appschema.Issue{Code: "app_bundle_invalid", Rule: "html", Message: "a bundle is one UTF-8 HTML document"}, nil
	}
	a, err := put(ctx, d, now, uploader, KindBundle, "text/html; charset=utf-8", content)
	return a, nil, err
}

// PutImage keeps a gallery image: a PNG, JPEG, GIF or WebP of at most 5 MB, judged from its bytes.
func PutImage(ctx context.Context, d pdb.DBTX, now time.Time, uploader int64, content []byte) (Asset, *appschema.Issue, error) {
	mime := http.DetectContentType(content)
	switch {
	case len(content) > MaxImageBytes:
		return Asset{}, &appschema.Issue{Code: appschema.CodeTooLarge, Rule: "size", Message: "an image has at most 5 MB"}, nil
	case mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp":
		return Asset{}, &appschema.Issue{Code: "app_upload_wrong_kind", Rule: "image", Message: "an image is a PNG, JPEG, GIF or WebP file"}, nil
	}
	a, err := put(ctx, d, now, uploader, KindImage, mime, content)
	return a, nil, err
}

func put(ctx context.Context, d pdb.DBTX, now time.Time, uploader int64, kind, mime string, content []byte) (Asset, error) {
	a := Asset{ID: newID(), Uploader: uploader, Kind: kind, Mime: mime, SHA256: fingerprint(content), Size: int64(len(content)), Content: content}
	err := db.New(d).PutAsset(ctx, db.PutAssetParams{PublicID: a.ID, UploaderID: uploader, Kind: kind, Mime: mime, Size: a.Size, Sha256: a.SHA256, Content: content, CreatedAt: now.UnixMilli()})
	return a, err
}

// GetAsset reads a stored file; ok is false when there is none.
func GetAsset(ctx context.Context, d pdb.DBTX, id string) (Asset, bool, error) {
	r, err := db.New(d).GetAsset(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, false, nil
	}
	return Asset{ID: r.PublicID, Uploader: r.UploaderID, Kind: r.Kind, Mime: r.Mime, SHA256: r.Sha256, Size: r.Size, Content: r.Content}, err == nil, err
}

func assetInfo(ctx context.Context, d pdb.DBTX, id string) (Asset, bool, error) {
	r, err := db.New(d).GetAssetInfo(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, false, nil
	}
	return Asset{ID: r.PublicID, Uploader: r.UploaderID, Kind: r.Kind, Mime: r.Mime, SHA256: r.Sha256, Size: r.Size}, err == nil, err
}
