package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// identityRoutes are the routes of who am I, the crew list, agents. Only the work package that owns this module edits this file.
var identityRoutes = []Route{
	{Method: "GET", Pattern: "/api/me", Auth: authz.HumanLimited, Lease: true, handle: (*Server).me},
	{Method: "GET", Pattern: "/api/identities", Auth: authz.HumanLimited, handle: (*Server).identities},
	{Method: "PATCH", Pattern: "/api/me/profile", Auth: authz.Human, Lease: true, handle: (*Server).patchProfile},
	{Method: "GET", Pattern: "/api/identities/:id/avatar.svg", Auth: authz.Human, Lease: true, handle: (*Server).avatar},
	{Method: "POST", Pattern: "/api/crew/agents", Auth: authz.Owner, StepUp: "identity.create", handle: (*Server).createAgent},
	{Method: "POST", Pattern: "/api/identities/:id/disable", Auth: authz.Owner, handle: (*Server).disableIdentity},
	// A handle change (I-51): the agent asks with its lease; the owner decides with one tap, or changes it in Crew. No step-up.
	{Method: "POST", Pattern: "/api/me/handle", Auth: authz.Lease, handle: (*Server).requestHandle},
	{Method: "POST", Pattern: "/api/identities/:id/handle", Auth: authz.Owner, handle: (*Server).changeHandle},
	{Method: "POST", Pattern: "/api/handle-requests/:ref/approve", Auth: authz.Owner, handle: decideHandle(true)},
	{Method: "POST", Pattern: "/api/handle-requests/:ref/deny", Auth: authz.Owner, handle: decideHandle(false)},
}
