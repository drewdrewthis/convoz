package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
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
	handle  handler
}

// Routes is the whole public API of S1a. Machine, session and crew routes join it in later slices.
var Routes = []Route{
	{Method: "GET", Pattern: "/healthz", Auth: authz.Pub, handle: (*Server).health},
	{Method: "GET", Pattern: "/api/version", Auth: authz.Pub, handle: (*Server).version},

	{Method: "GET", Pattern: "/bootstrap", Auth: authz.Pub, handle: page("bootstrap")},
	{Method: "GET", Pattern: "/signin", Auth: authz.Pub, handle: page("signin")},
	{Method: "GET", Pattern: "/recover", Auth: authz.Pub, handle: page("recover")},
	{Method: "GET", Pattern: "/", Auth: authz.Human, Page: true, handle: page("now")},
	{Method: "GET", Pattern: "/onboarding", Auth: authz.Human, Page: true, handle: page("onboarding")},
	{Method: "GET", Pattern: "/settings/passkeys", Auth: authz.Human, Page: true, handle: page("passkeys")},
	{Method: "GET", Pattern: "/assets/console.js", Auth: authz.Pub, handle: asset("console.js", "text/javascript; charset=utf-8")},
	{Method: "GET", Pattern: "/assets/console.css", Auth: authz.Pub, handle: asset("console.css", "text/css; charset=utf-8")},

	{Method: "POST", Pattern: "/api/auth/bootstrap/options", Auth: authz.Pub, handle: (*Server).bootstrapOptions},
	{Method: "POST", Pattern: "/api/auth/bootstrap/verify", Auth: authz.Pub, handle: (*Server).bootstrapVerify},
	{Method: "POST", Pattern: "/api/auth/passkey/login/options", Auth: authz.Pub, handle: (*Server).loginOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/login/verify", Auth: authz.Pub, handle: (*Server).loginVerify},
	{Method: "POST", Pattern: "/api/auth/recovery", Auth: authz.Pub, handle: (*Server).recovery},

	{Method: "POST", Pattern: "/api/auth/passkey/register/options", Auth: authz.HumanLimited, handle: (*Server).registerOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/register/verify", Auth: authz.HumanLimited, StepUp: "passkey.add", handle: (*Server).registerVerify},
	{Method: "POST", Pattern: "/api/auth/step-up/options", Auth: authz.Human, handle: (*Server).stepUpOptions},
	{Method: "POST", Pattern: "/api/auth/step-up/verify", Auth: authz.Human, handle: (*Server).stepUpVerify},
	{Method: "POST", Pattern: "/api/auth/logout", Auth: authz.HumanLimited, handle: (*Server).logout},

	{Method: "GET", Pattern: "/api/me", Auth: authz.HumanLimited, handle: (*Server).me},
	{Method: "GET", Pattern: "/api/identities", Auth: authz.HumanLimited, handle: (*Server).identities},
	{Method: "GET", Pattern: "/api/me/devices", Auth: authz.Human, handle: (*Server).devices},
	{Method: "DELETE", Pattern: "/api/me/devices/:id", Auth: authz.Human, handle: (*Server).deleteDevice},
	{Method: "GET", Pattern: "/api/me/passkeys", Auth: authz.Human, handle: (*Server).passkeys},
	{Method: "DELETE", Pattern: "/api/me/passkeys/:id", Auth: authz.Human, StepUp: "passkey.remove", handle: (*Server).deletePasskey},
	{Method: "POST", Pattern: "/api/me/recovery-codes", Auth: authz.Human, StepUp: "recovery.regenerate", handle: (*Server).regenerateRecoveryCodes},
	{Method: "GET", Pattern: "/api/admin/audit", Auth: authz.Owner, handle: (*Server).auditList},
}

func page(name string) handler {
	serve := console.Page(name)
	return func(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { serve(w, r) }
}

func asset(name, contentType string) handler {
	serve := console.Asset(name, contentType)
	return func(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { serve(w, r) }
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request, _ *call) {
	_, _ = w.Write([]byte("ok"))
}
