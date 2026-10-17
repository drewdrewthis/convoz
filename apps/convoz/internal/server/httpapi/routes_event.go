package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// eventRoutes are the routes of the live stream and sync. Only the work package that owns this module edits this file.
var eventRoutes = []Route{
	{Method: "GET", Pattern: "/api/stream", Auth: authz.Human, RefuseLease: true, handle: (*Server).stream},
	{Method: "GET", Pattern: "/api/sync", Auth: authz.Human, RefuseLease: true, handle: (*Server).syncDelta},
	{Method: "GET", Pattern: "/api/sync/snapshot", Auth: authz.Human, RefuseLease: true, handle: (*Server).syncSnapshot},
	{Method: "GET", Pattern: "/api/ping", Auth: authz.Human, Lease: true, handle: (*Server).ping},
}
