package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// planRoutes are the routes of plans (plan.feature). Only the work package that owns this module edits this file.
var planRoutes = []Route{
	// The agent replaces its own plan; it rides on the status scope, as a plan also moves the agent's status.
	{Method: "PUT", Pattern: "/api/conversations/:id/plan", Auth: authz.Lease, Scope: "status", handle: (*Server).putPlan},
	{Method: "GET", Pattern: "/api/plans", Auth: authz.Human, handle: (*Server).getPlans},
}
