package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// readstateRoutes are the routes of read positions. Only the work package that owns this module edits this file.
var readstateRoutes = []Route{
	{Method: "POST", Pattern: "/api/conversations/:id/read", Auth: authz.Human, Lease: true, handle: (*Server).markRead},
	// The replies of one thread, found from its root message (I-6, I-7).
	{Method: "GET", Pattern: "/api/messages/:id/replies", Auth: authz.Human, Lease: true, handle: (*Server).listReplies},
}
