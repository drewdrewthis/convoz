package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
)

// handler is one route's code. c carries the caller already authenticated for the route's Auth class.
type handler func(s *Server, w http.ResponseWriter, r *http.Request, c *call)

// Route is one row of the route table: the mux is built from these rows, and GET /__test/routes lists them.
type Route struct {
	Method  string
	Pattern string // ":name" segments are path parameters
	Auth    authz.Auth
	StepUp  string // the action the request must carry a step-up for ("" for none)
	Page    bool   // a browser page: a caller who is not signed in is redirected, not told 401

	Lease       bool // a session lease also meets the route (the route lists L next to its Auth class)
	RefuseLease bool // a lease is told 403, not 401: an agent credential can never do this
	NoCSRF      bool // a write that carries no cookie and no Authorization (a CLI), so the browser Origin check does not apply
	NoLimit     bool // exempt from the per-source public limit (its own protocol limits it)
	handle      handler
}

// check is Auth.Check, widened by Lease.
func (r Route) check(p authz.Principal) error {
	if r.Lease && p.SessionID != 0 {
		return nil
	}
	return r.Auth.Check(p)
}

// Routes is the whole public API: the owner's, the machines', the agents', and the chat routes both people and agents use.
var Routes = []Route{
	{Method: "GET", Pattern: "/healthz", Auth: authz.Pub, handle: (*Server).health},
	{Method: "GET", Pattern: "/api/version", Auth: authz.Pub, handle: (*Server).version},

	{Method: "GET", Pattern: "/bootstrap", Auth: authz.Pub, handle: page("bootstrap")},
	{Method: "GET", Pattern: "/signin", Auth: authz.Pub, handle: page("signin")},
	{Method: "GET", Pattern: "/recover", Auth: authz.Pub, handle: page("recover")},
	{Method: "GET", Pattern: "/", Auth: authz.Human, Page: true, handle: page("now")},
	{Method: "GET", Pattern: "/chats", Auth: authz.Human, Page: true, handle: page("chats")},
	{Method: "GET", Pattern: "/chats/new", Auth: authz.Human, Page: true, handle: page("chat")},
	{Method: "GET", Pattern: "/chats/:id", Auth: authz.Human, Page: true, handle: (*Server).chatPage},
	{Method: "GET", Pattern: "/crew/machines", Auth: authz.Human, Page: true, handle: page("machines")},
	{Method: "GET", Pattern: "/onboarding", Auth: authz.Human, Page: true, handle: page("onboarding")},
	{Method: "GET", Pattern: "/settings/passkeys", Auth: authz.Human, Page: true, handle: page("passkeys")},
	{Method: "GET", Pattern: "/settings/recovery", Auth: authz.Human, Page: true, handle: page("recovery")},
	{Method: "GET", Pattern: "/account", Auth: authz.Human, Page: true, handle: page("account")},
	{Method: "GET", Pattern: "/assets/console.js", Auth: authz.Pub, handle: asset("console.js", "text/javascript; charset=utf-8")},
	{Method: "GET", Pattern: "/assets/console.css", Auth: authz.Pub, handle: asset("console.css", "text/css; charset=utf-8")},
	{Method: "GET", Pattern: "/assets/chat.js", Auth: authz.Pub, handle: asset("chat.js", "text/javascript; charset=utf-8")},
	{Method: "GET", Pattern: "/assets/lookalikes.js", Auth: authz.Pub, handle: lookalikesAsset},
	{Method: "GET", Pattern: "/assets/icon-192.png", Auth: authz.Pub, handle: asset("icon-192.png", "image/png")},
	{Method: "GET", Pattern: "/assets/icon-512.png", Auth: authz.Pub, handle: asset("icon-512.png", "image/png")},
	{Method: "GET", Pattern: "/favicon.ico", Auth: authz.Pub, handle: asset("favicon.ico", "image/vnd.microsoft.icon")},
	{Method: "GET", Pattern: "/apple-touch-icon.png", Auth: authz.Pub, handle: asset("apple-touch-icon.png", "image/png")},
	{Method: "GET", Pattern: "/manifest.webmanifest", Auth: authz.Pub, handle: asset("manifest.webmanifest", "application/manifest+json")},

	{Method: "POST", Pattern: "/api/auth/bootstrap/check", Auth: authz.Pub, handle: (*Server).bootstrapCheck},
	{Method: "POST", Pattern: "/api/auth/bootstrap/options", Auth: authz.Pub, handle: (*Server).bootstrapOptions},
	{Method: "POST", Pattern: "/api/auth/bootstrap/verify", Auth: authz.Pub, handle: (*Server).bootstrapVerify},
	{Method: "POST", Pattern: "/api/auth/passkey/login/options", Auth: authz.Pub, handle: (*Server).loginOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/login/verify", Auth: authz.Pub, handle: (*Server).loginVerify},
	{Method: "POST", Pattern: "/api/auth/recovery", Auth: authz.Pub, handle: (*Server).recovery},

	{Method: "POST", Pattern: "/api/auth/passkey/register/options", Auth: authz.HumanLimited, handle: (*Server).registerOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/register/verify", Auth: authz.HumanLimited, StepUp: "passkey.add", handle: (*Server).registerVerify},
	{Method: "POST", Pattern: "/api/auth/step-up/options", Auth: authz.Human, RefuseLease: true, handle: (*Server).stepUpOptions},
	{Method: "POST", Pattern: "/api/auth/step-up/verify", Auth: authz.Human, handle: (*Server).stepUpVerify},
	{Method: "POST", Pattern: "/api/auth/logout", Auth: authz.HumanLimited, handle: (*Server).logout},

	{Method: "GET", Pattern: "/api/me", Auth: authz.HumanLimited, Lease: true, handle: (*Server).me},
	{Method: "GET", Pattern: "/api/identities", Auth: authz.HumanLimited, handle: (*Server).identities},
	{Method: "GET", Pattern: "/api/me/devices", Auth: authz.Human, handle: (*Server).devices},
	{Method: "DELETE", Pattern: "/api/me/devices/:id", Auth: authz.Human, handle: (*Server).deleteDevice},
	{Method: "GET", Pattern: "/api/me/passkeys", Auth: authz.Human, handle: (*Server).passkeys},
	{Method: "DELETE", Pattern: "/api/me/passkeys/:id", Auth: authz.Human, StepUp: "passkey.remove", handle: (*Server).deletePasskey},
	{Method: "GET", Pattern: "/api/me/recovery-codes", Auth: authz.Human, handle: (*Server).recoveryCount},
	{Method: "POST", Pattern: "/api/me/recovery-codes", Auth: authz.Human, StepUp: "recovery.regenerate", handle: (*Server).regenerateRecoveryCodes},
	{Method: "GET", Pattern: "/api/admin/audit", Auth: authz.Owner, handle: (*Server).auditList},

	// The machine login (device flow): no cookie and no credential, so no Origin check; the protocol limits the polls.
	{Method: "POST", Pattern: "/api/device/code", Auth: authz.Pub, NoCSRF: true, handle: (*Server).deviceCode},
	{Method: "POST", Pattern: "/api/device/token", Auth: authz.Pub, NoCSRF: true, NoLimit: true, handle: (*Server).deviceToken},

	{Method: "GET", Pattern: "/api/now", Auth: authz.Owner, handle: (*Server).now},
	{Method: "GET", Pattern: "/api/machines/requests", Auth: authz.Owner, handle: (*Server).machineRequests},
	{Method: "POST", Pattern: "/api/machines/requests/deny-all", Auth: authz.Owner, handle: (*Server).denyAllRequests},
	{Method: "POST", Pattern: "/api/machines/requests/:id/approve", Auth: authz.Owner, StepUp: "machine.approve", handle: (*Server).approveRequest},
	{Method: "POST", Pattern: "/api/machines/requests/:id/deny", Auth: authz.Owner, handle: (*Server).denyRequest},
	{Method: "GET", Pattern: "/api/machines", Auth: authz.Owner, handle: (*Server).machines},
	{Method: "PATCH", Pattern: "/api/machines/:id", Auth: authz.Owner, StepUp: "machine.allow", handle: (*Server).patchMachine},
	{Method: "POST", Pattern: "/api/machines/:id/reveal", Auth: authz.Owner, StepUp: "machine.reveal", handle: (*Server).revealKey},
	{Method: "POST", Pattern: "/api/machines/:id/regenerate", Auth: authz.Owner, StepUp: "machine.regenerate", handle: (*Server).regenerateKey},
	{Method: "POST", Pattern: "/api/machines/:id/revoke", Auth: authz.Owner, StepUp: "machine.revoke", handle: (*Server).revokeMachine},

	{Method: "POST", Pattern: "/api/sessions", Auth: authz.Machine, handle: (*Server).mintSession},
	{Method: "POST", Pattern: "/api/sessions/renew", Auth: authz.Lease, handle: (*Server).renewSession},
	{Method: "DELETE", Pattern: "/api/sessions/me", Auth: authz.Lease, handle: (*Server).endSession},
	{Method: "GET", Pattern: "/api/sessions", Auth: authz.Owner, handle: (*Server).sessions},

	{Method: "GET", Pattern: "/api/conversations", Auth: authz.Human, Lease: true, handle: (*Server).listConversations},
	{Method: "POST", Pattern: "/api/conversations", Auth: authz.Human, RefuseLease: true, handle: (*Server).createConversation},
	{Method: "GET", Pattern: "/api/conversations/:id", Auth: authz.Human, Lease: true, handle: (*Server).getConversation},
	{Method: "GET", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, handle: (*Server).listMessages},
	{Method: "POST", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, handle: (*Server).postMessage},
	{Method: "POST", Pattern: "/api/conversations/:id/read", Auth: authz.Human, Lease: true, handle: (*Server).markRead},
	{Method: "GET", Pattern: "/api/stream", Auth: authz.Human, RefuseLease: true, handle: (*Server).stream},
	{Method: "GET", Pattern: "/api/inbox", Auth: authz.Lease, handle: (*Server).inboxPoll},
	{Method: "POST", Pattern: "/api/inbox/ack", Auth: authz.Lease, handle: (*Server).ackInbox},

	{Method: "POST", Pattern: "/api/crew/agents", Auth: authz.Owner, StepUp: "identity.create", handle: (*Server).createAgent},
	{Method: "POST", Pattern: "/api/identities/:id/disable", Auth: authz.Owner, StepUp: "identity.disable", handle: (*Server).disableIdentity},
}

func page(name string) handler {
	serve := console.Page(name)
	return func(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { serve(w, r) }
}

func asset(name, contentType string) handler {
	serve := console.Asset(name, contentType)
	return func(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { serve(w, r) }
}

// lookalikesAsset hands the confusable-punctuation set to chat.js, so the identity table stays its only owner.
func lookalikesAsset(_ *Server, w http.ResponseWriter, _ *http.Request, _ *call) {
	set, _ := json.Marshal(identity.PunctuationLookalikes())
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	_, _ = w.Write(append([]byte("globalThis.CONVOZ_LOOKALIKES="), append(set, ';')...))
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request, _ *call) {
	_, _ = w.Write([]byte("ok"))
}
