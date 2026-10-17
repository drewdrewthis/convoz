package appkit

import (
	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
)

// FrameCSP is the policy of a Tier-2 frame document (docs/messages-apps-spec.md §5.4, I-46): scripts and styles that sit in the
// document, no network, no nested frames, no navigation by form, and `sandbox allow-scripts` again in the header, so the
// document is sandboxed even when it is opened on its own.
const FrameCSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; " +
	"child-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"

// FrameHeaders are the other headers of a frame document. It is immutable by its hash, so a browser keeps it for good.
var FrameHeaders = map[string]string{
	"Content-Type":                 "text/html; charset=utf-8",
	"Content-Security-Policy":      FrameCSP,
	"X-Content-Type-Options":       "nosniff",
	"Referrer-Policy":              "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cache-Control":                "private, max-age=31536000, immutable",
}

// FrameBundleID returns the upload of the bundle of a frame app when hash is the SHA-256 the app names for it. A message that is
// not a frame app and a wrong hash both answer ok false, so the route cannot tell them apart.
func FrameBundleID(app []byte, hash string) (id string, ok bool) {
	a, issue := appschema.Check(app)
	if issue != nil || a.Type != "frame" {
		return "", false
	}
	b := a.Refs().Bundle
	if b == nil || b.SHA256 != hash {
		return "", false
	}
	return b.Upload, true
}
