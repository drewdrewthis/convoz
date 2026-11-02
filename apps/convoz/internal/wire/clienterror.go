package wire

// ClientErrorRequest is POST /api/client-errors: one uncaught error of the web app, for the server's own log.
// Page is a path with no query; the app never sends message text, tokens or conversation content.
// Kind is the error's class (TypeError, ChunkLoadError, ...), the only part that is counted; the server matches it exactly.
type ClientErrorRequest struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Page    string `json:"page"`
	Build   string `json:"build"`
	UA      string `json:"ua"`
	At      int64  `json:"at"`
}

// ClientEventSendFailed is the one event POST /api/client-events knows: a message send the web app gave up on.
const ClientEventSendFailed = "send_failed"

// ClientEventRequest is POST /api/client-events: one event of the web app, counted and never stored. Other fields are ignored.
type ClientEventRequest struct {
	Event string `json:"event"`
}
