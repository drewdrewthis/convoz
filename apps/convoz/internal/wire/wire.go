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
	Field   string `json:"field,omitempty"` // the request field a 400 is about
	// RetryAfter is how many seconds until a 429 may pass; the Retry-After header says the same.
	RetryAfter int `json:"retry_after,omitempty"`
}

// Error codes the CLI acts on.
const (
	CodeAuthorizationPending = "authorization_pending"
	CodeSlowDown             = "slow_down"
	CodeAccessDenied         = "access_denied"
	CodeExpiredToken         = "expired_token"
	CodeSessionEnded         = "session_ended"
	CodeTooManyPending       = "too_many_pending"
)

// Routes of the machine login and the session lease, as the CLI calls them.
const (
	RouteDeviceCode  = "/api/device/code"
	RouteDeviceToken = "/api/device/token"
	RouteSessions    = "/api/sessions"
	RouteSessionsMe  = "/api/sessions/me"
	RouteMe          = "/api/me"
)

// HostInfo is what a machine says about itself when it asks to log in. The owner sees it labelled as reported.
type HostInfo struct {
	Hostname   string `json:"hostname"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	CLIVersion string `json:"cli_version"`
}

// DeviceCodeRequest is POST /api/device/code.
type DeviceCodeRequest struct {
	Name     string   `json:"name"`
	HostInfo HostInfo `json:"host_info"`
}

// DeviceCodeResponse starts the wait: the CLI prints UserCode and polls with DeviceCode every IntervalMs.
type DeviceCodeResponse struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	Interval   int    `json:"interval"`
	IntervalMs int64  `json:"interval_ms"`
	ExpiresIn  int    `json:"expires_in"`
}

// DeviceTokenRequest is POST /api/device/token.
type DeviceTokenRequest struct {
	DeviceCode string `json:"device_code"`
}

// DeviceTokenResponse carries the machine key once the owner approved. It is the only answer that holds a key.
type DeviceTokenResponse struct {
	MachineKey  string `json:"machine_key"`
	MachineID   int64  `json:"machine_id"`
	MachineName string `json:"machine_name"`
}

// CreateIdentity asks the server to make the agent identity if there is none (needs the create_identity scope).
type CreateIdentity struct {
	DisplayName string `json:"display_name"`
}

// MintRequest is POST /api/sessions (authorized by the machine key).
type MintRequest struct {
	As       string          `json:"as"`
	ClientID string          `json:"client_id"`
	Label    string          `json:"label"`
	Create   *CreateIdentity `json:"create,omitempty"`
}

// SessionInfo describes one lease.
type SessionInfo struct {
	ID        int64  `json:"id"`
	Identity  string `json:"identity"`
	Machine   string `json:"machine"`
	ClientID  string `json:"client_id"`
	Label     string `json:"label"`
	ExpiresAt int64  `json:"expires_at"`
}

// MintResponse holds the lease, which is shown once.
type MintResponse struct {
	Lease   string      `json:"lease"`
	Session SessionInfo `json:"session"`
}

// MeResponse is GET /api/me with a lease.
type MeResponse struct {
	Identity struct {
		ID          int64  `json:"id"`
		Handle      string `json:"handle"`
		DisplayName string `json:"display_name"`
		Kind        string `json:"kind"`
	} `json:"identity"`
	Machine struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"machine"`
	Session struct {
		ID        int64  `json:"id"`
		ClientID  string `json:"client_id"`
		Label     string `json:"label"`
		ExpiresAt int64  `json:"expires_at"`
	} `json:"session"`
	Scopes       []string `json:"scopes"`
	LiveSessions int64    `json:"live_sessions"`
}

// MaxHoldSeconds is the longest the server holds one inbox poll: short enough for proxies, mobile NAT and
// `tailscale serve` (design §3.8). The CLI asks for no more, and a longer --wait is several polls.
const MaxHoldSeconds = 25
