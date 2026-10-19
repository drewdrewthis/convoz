package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const (
	clientErrorBody     = 16 << 10 // the biggest report the app sends is a 4 KB stack and a short message
	clientErrorsPerHour = 60       // per device session
	clientErrorMessage  = 500
	clientErrorStack    = 4 << 10
	clientErrorField    = 200 // page, build and user agent
)

// clientError is POST /api/client-errors: the web app reports an uncaught error, and the server writes one line to its own log
// (journalctl). Nothing is stored. The owner's device session only: an agent or an anonymous caller never reaches it.
// Values are quoted, so a newline or a quote in a report cannot forge another log line. Past the limit it answers 429; a body over
// 16 KB is a 400.
func (s *Server) clientError(w http.ResponseWriter, r *http.Request, c *call) {
	now := s.Clock.Now()
	key := strconv.FormatInt(c.p.DeviceID, 10)
	if !s.clientErrorLimit.Allow(key, now) {
		tooMany(w, s.clientErrorLimit.RetryAfter(key, now), "Too many error reports. Slow down.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, clientErrorBody)
	var in wire.ClientErrorRequest
	if !decode(w, r, &in) {
		return
	}
	s.Log.Printf("client_error build=%q page=%q ua=%q message=%q stack=%q",
		clipTo(in.Build, clientErrorField), pathOnly(in.Page), clipTo(in.UA, clientErrorField), clipTo(in.Message, clientErrorMessage), clipTo(in.Stack, clientErrorStack))
	w.WriteHeader(http.StatusNoContent)
}

// pathOnly keeps the path of a page and drops any query or fragment.
func pathOnly(page string) string {
	path, _, _ := strings.Cut(page, "?")
	path, _, _ = strings.Cut(path, "#")
	return clipTo(path, clientErrorField)
}

// clipTo cuts s to at most n bytes without splitting a character.
func clipTo(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
