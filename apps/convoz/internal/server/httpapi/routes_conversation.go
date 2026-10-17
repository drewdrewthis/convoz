package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// conversationRoutes are the routes of conversations, participants, pickup, trash. Only the work package that owns this module edits this file.
var conversationRoutes = []Route{
	{Method: "GET", Pattern: "/api/conversations", Auth: authz.Human, Lease: true, handle: (*Server).listConversations},
	{Method: "POST", Pattern: "/api/conversations", Auth: authz.Human, RefuseLease: true, handle: (*Server).createConversation},
	{Method: "GET", Pattern: "/api/conversations/:id", Auth: authz.Human, Lease: true, handle: (*Server).getConversation},
}
