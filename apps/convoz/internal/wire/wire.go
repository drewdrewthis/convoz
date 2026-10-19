// Package wire holds the JSON shapes and constants the server and the CLI share.
// The CLI imports this package and nothing under internal/server.
package wire

// AdminBootstrapLink is the admin-socket route that mints a bootstrap link. It is never on the HTTP listener.
const AdminBootstrapLink = "/admin/bootstrap-link"

// AdminInvites is the admin-socket route that makes an invite for the owner (`convoz invite` on the server's own box). It is never on the HTTP listener.
const AdminInvites = "/admin/invites"

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
	Path    string `json:"path,omitempty"`  // the JSON pointer inside an app or a result a 400 is about ("/props/colour")
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
	CodeInviteSpent          = "invite_spent"
	CodeHandleTaken          = "handle_taken"
	CodeRequestDenied        = "request_denied"
	CodeRequestExpired       = "request_expired"
	CodeInviteCap            = "invite_cap"
	CodeNotInConversation    = "not_in_conversation"
	// CodeHandleRenamed refuses `as` with a handle the agent gave up more than 30 days ago; the message names the new one (I-51).
	CodeHandleRenamed = "handle_renamed"
)

// Routes of the machine login and the session lease, as the CLI calls them.
const (
	RouteDeviceCode  = "/api/device/code"
	RouteDeviceToken = "/api/device/token"
	RouteSessions    = "/api/sessions"
	RouteSessionsMe  = "/api/sessions/me"
	RouteMe          = "/api/me"
	RouteInvites     = "/api/invites"
	RouteFiles       = "/api/files"
)

// HostInfo is what a machine says about itself when it asks to log in. The owner sees it labelled as reported.
type HostInfo struct {
	Hostname   string `json:"hostname"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	CLIVersion string `json:"cli_version"`
}

// IdentityIntro is the identity an agent sends about itself with a login or a session request. Only the handle is needed; the
// owner sees every other field as the agent's own words, never as the server's.
type IdentityIntro struct {
	Handle         string `json:"handle"`
	DisplayName    string `json:"display_name,omitempty"`
	Description    string `json:"description,omitempty"`
	AvatarSVG      string `json:"avatar_svg,omitempty"`
	ConversationID int64  `json:"conversation_id,omitempty"`
}

// DeviceCodeRequest is POST /api/device/code. With Identity, the owner's one Approve makes the machine and the identity.
type DeviceCodeRequest struct {
	Name     string         `json:"name"`
	HostInfo HostInfo       `json:"host_info"`
	Identity *IdentityIntro `json:"identity,omitempty"`
	// Invite is the one-use token a request over the internet needs; the server ignores it on the tailnet.
	Invite string `json:"invite,omitempty"`
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

// CreateIdentity asks the server to make the agent identity if there is none. A machine with the create_identity scope that allows the
// handle gets it at once; any other machine files a request (answered 202) and asks again with Request until the owner decides.
type CreateIdentity struct {
	DisplayName    string `json:"display_name,omitempty"`
	Description    string `json:"description,omitempty"`
	AvatarSVG      string `json:"avatar_svg,omitempty"`
	ConversationID int64  `json:"conversation_id,omitempty"`
	Request        string `json:"request,omitempty"`
	// Invite is the one-use token a request over the internet needs; the server ignores it on the tailnet.
	Invite string `json:"invite,omitempty"`
}

// MintPending is the 202 answer of POST /api/sessions while the owner has not decided the identity request.
type MintPending struct {
	Request IdentityRequestState `json:"request"`
}

// IdentityRequestState names a waiting request by its unguessable ref.
type IdentityRequestState struct {
	Ref       string `json:"ref"`
	State     string `json:"state"`
	ExpiresAt int64  `json:"expires_at"`
	// IntervalMs is how long the machine waits between two asks.
	IntervalMs int64 `json:"interval_ms"`
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
	ID         int64  `json:"id"`
	Identity   string `json:"identity"`
	IdentityID int64  `json:"identity_id,omitempty"`
	Machine    string `json:"machine"`
	ClientID   string `json:"client_id"`
	Label      string `json:"label"`
	ExpiresAt  int64  `json:"expires_at"`
}

// MintResponse holds the lease, which is shown once.
type MintResponse struct {
	Lease   string      `json:"lease"`
	Session SessionInfo `json:"session"`
	// Renamed is set when `as` named a handle the agent had before: it works until Until, then the mint is refused (I-51).
	Renamed *Renamed `json:"renamed,omitempty"`
}

// Renamed says that a handle the caller used is the agent's old one.
type Renamed struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Until int64  `json:"until"`
}

// PreviousHandle is a handle a lease's agent had before; `--as` with it works until Until (Works says whether it still does).
type PreviousHandle struct {
	Handle string `json:"handle"`
	Until  int64  `json:"until"`
	Works  bool   `json:"works"`
}

// MeResponse is GET /api/me with a lease.
type MeResponse struct {
	Identity struct {
		ID          int64  `json:"id"`
		Handle      string `json:"handle"`
		DisplayName string `json:"display_name"`
		Kind        string `json:"kind"`
		// Description and Capabilities are the agent's own words about itself (convoz profile).
		Description  string   `json:"description,omitempty"`
		Capabilities []string `json:"capabilities,omitempty"`
		// PreviousHandles are the handles the agent had before, newest first (I-51).
		PreviousHandles []PreviousHandle `json:"previous_handles,omitempty"`
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
