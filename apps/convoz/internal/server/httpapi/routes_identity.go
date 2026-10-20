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
	// The owner makes an agent a triage agent (migrations 0038, 0040); the agent asks what waits on the owner.
	{Method: "PUT", Pattern: "/api/agents/:id/triage", Auth: authz.Owner, StepUp: "identity.triage", handle: (*Server).setTriage},
	{Method: "GET", Pattern: "/api/waiting", Auth: authz.Lease, handle: (*Server).waiting},
	// A handle change (I-51): the agent changes its own with its lease, at once, or the owner changes it in Crew. No step-up.
	{Method: "POST", Pattern: "/api/me/handle", Auth: authz.Lease, handle: (*Server).changeOwnHandle},
	{Method: "POST", Pattern: "/api/identities/:id/handle", Auth: authz.Owner, handle: (*Server).changeHandle},
}
