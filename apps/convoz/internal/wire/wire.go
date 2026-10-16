// Package wire holds the JSON shapes and constants the server and the CLI share.
// The CLI imports this package and nothing under internal/server.
package wire

// AdminBootstrapLink is the admin-socket route that mints a bootstrap link. It is never on the HTTP listener.
const AdminBootstrapLink = "/admin/bootstrap-link"

// BootstrapLink is the admin-socket answer to AdminBootstrapLink.
type BootstrapLink struct {
	Token     string `json:"token"`
	URL       string `json:"url"`
	ExpiresAt string `json:"expires_at"`
}

// Error is the body of every error answer: {"error":{"code","message"}}.
type Error struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail is the code (stable, for programs) and message (for people).
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
