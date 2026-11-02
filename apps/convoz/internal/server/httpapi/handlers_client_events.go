package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const (
	clientEventBody     = 1 << 10 // an event is one short word
	clientEventsPerHour = 60      // per device session
)

// clientEvent is POST /api/client-events: the web app reports an event with no content (a send it gave up on), and the server adds
// one to a counter. Nothing is stored or logged. The owner's device session only. Fields other than event are ignored, so the
// app can add some without breaking an older server; an unknown event or a body over 1 KB is a 400; past the limit it answers 429.
func (s *Server) clientEvent(w http.ResponseWriter, r *http.Request, c *call) {
	now := s.Clock.Now()
	key := strconv.FormatInt(c.p.DeviceID, 10)
	if !s.clientEventLimit.Allow(key, now) {
		tooMany(w, s.clientEventLimit.RetryAfter(key, now), "Too many events. Slow down.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, clientEventBody))
	var in wire.ClientEventRequest
	if err != nil || json.Unmarshal(body, &in) != nil || in.Event != wire.ClientEventSendFailed {
		writeErr(w, http.StatusBadRequest, "invalid_request", "The request body is not valid.")
		return
	}
	s.Telemetry.CountSendFailure()
	w.WriteHeader(http.StatusNoContent)
}
