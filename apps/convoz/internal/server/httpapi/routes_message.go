package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// messageRoutes are the routes of messages. Only the work package that owns this module edits this file.
var messageRoutes = []Route{
	{Method: "GET", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, handle: (*Server).listMessages},
	{Method: "POST", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, handle: (*Server).postMessage},
}
