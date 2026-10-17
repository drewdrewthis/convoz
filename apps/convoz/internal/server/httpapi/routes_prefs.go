package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// prefsRoutes are the routes of stars, mutes, the rail order, pins and agent status. Only the work package that owns this module edits this file.
var prefsRoutes = []Route{
	{Method: "PATCH", Pattern: "/api/conversations/:id/prefs", Auth: authz.Human, RefuseLease: true, handle: (*Server).patchPrefs},
	{Method: "PUT", Pattern: "/api/messages/:id/pin", Auth: authz.Human, RefuseLease: true, handle: pinHandler(true)},
	{Method: "DELETE", Pattern: "/api/messages/:id/pin", Auth: authz.Human, RefuseLease: true, handle: pinHandler(false)},
	{Method: "PUT", Pattern: "/api/status", Auth: authz.Lease, handle: (*Server).putStatus},
	{Method: "GET", Pattern: "/api/status", Auth: authz.Owner, Lease: true, handle: (*Server).getStatus},
}
