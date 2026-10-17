package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// unfurlRoutes are the routes of link previews. Only the work package that owns this module edits this file.
// A lease may meet the route so the visibility check runs for an agent as for anyone; the handler then refuses every agent.
var unfurlRoutes = []Route{
	{Method: "GET", Pattern: "/api/messages/:id/unfurl", Auth: authz.Human, Lease: true, handle: (*Server).getUnfurl},
}
