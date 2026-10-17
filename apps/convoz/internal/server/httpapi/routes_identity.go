package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// identityRoutes are the routes of who am I, the crew list, agents. Only the work package that owns this module edits this file.
var identityRoutes = []Route{
	{Method: "GET", Pattern: "/api/me", Auth: authz.HumanLimited, Lease: true, handle: (*Server).me},
	{Method: "PATCH", Pattern: "/api/me/profile", Auth: authz.Lease, handle: (*Server).patchProfile},
	{Method: "GET", Pattern: "/api/identities", Auth: authz.HumanLimited, handle: (*Server).identities},
	{Method: "POST", Pattern: "/api/crew/agents", Auth: authz.Owner, StepUp: "identity.create", handle: (*Server).createAgent},
	{Method: "POST", Pattern: "/api/identities/:id/disable", Auth: authz.Owner, StepUp: "identity.disable", handle: (*Server).disableIdentity},
}
