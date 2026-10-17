package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// eventRoutes are the routes of the live stream and sync. Only the work package that owns this module edits this file.
var eventRoutes = []Route{
	{Method: "GET", Pattern: "/api/stream", Auth: authz.Human, RefuseLease: true, handle: (*Server).stream},
}
