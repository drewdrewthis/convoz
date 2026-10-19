package wire

// ClientErrorRequest is POST /api/client-errors: one uncaught error of the web app, for the server's own log.
// Page is a path with no query; the app never sends message text, tokens or conversation content.
type ClientErrorRequest struct {
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Page    string `json:"page"`
	Build   string `json:"build"`
	UA      string `json:"ua"`
	At      int64  `json:"at"`
}
