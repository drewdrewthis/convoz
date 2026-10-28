package httpapi

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
)

// The owner listener's access log tells one browser tab from many without naming a person: the row id of the owner device
// (once the cookie is known), and two random ids the web app sends. X-Convoz-Tab is one per browser tab (sessionStorage),
// X-Convoz-Load one per page load (memory). Each is logged only when it is exactly 8 lowercase hex digits; any other value is
// dropped, never echoed. Gaps: a reload is a new load=, same tab=; a duplicated tab copies tab=; SW fetches carry neither.

// clientIDPattern is the only shape of a tab or load id that is logged.
var clientIDPattern = regexp.MustCompile(`^[0-9a-f]{8}$`)

type accessNoteKey struct{}

// accessNote is what a request learns while it is served that its log line names. logRequests puts one in the request
// context; authenticate fills it once the device is known (the same idea as statusWriter for the status).
type accessNote struct {
	device int64
}

// withAccessNote returns r carrying a fresh note, and the note.
func withAccessNote(r *http.Request) (*http.Request, *accessNote) {
	n := &accessNote{}
	return r.WithContext(context.WithValue(r.Context(), accessNoteKey{}, n)), n
}

// noteDevice records the authenticated owner device for the request's log line. Outside logRequests it does nothing.
func noteDevice(ctx context.Context, id int64) {
	if n, ok := ctx.Value(accessNoteKey{}).(*accessNote); ok {
		n.device = id
	}
}

// ownerFields is the owner listener's tail of a log line: " dev=<id>" when a device signed the request in, then " tab=<id>"
// and " load=<id>" when each header is a valid id. Nothing else of the request is read.
func ownerFields(r *http.Request, n *accessNote) string {
	out := ""
	if n.device != 0 {
		out += " dev=" + strconv.FormatInt(n.device, 10)
	}
	if v := r.Header.Get("X-Convoz-Tab"); clientIDPattern.MatchString(v) {
		out += " tab=" + v
	}
	if v := r.Header.Get("X-Convoz-Load"); clientIDPattern.MatchString(v) {
		out += " load=" + v
	}
	return out
}
