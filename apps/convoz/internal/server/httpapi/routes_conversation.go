package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// conversationRoutes are the routes of conversations, participants, trash. Only the work package that owns this module edits this file.
var conversationRoutes = []Route{
	{Method: "GET", Pattern: "/api/conversations", Auth: authz.Human, Lease: true, handle: (*Server).listConversations},
	{Method: "POST", Pattern: "/api/conversations", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).createConversation},
	{Method: "GET", Pattern: "/api/conversations/:id", Auth: authz.Human, Lease: true, handle: (*Server).getConversation},
	{Method: "PATCH", Pattern: "/api/conversations/:id", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).patchConversation},
	{Method: "DELETE", Pattern: "/api/conversations/:id", Auth: authz.Owner, handle: (*Server).deleteConversation},
	{Method: "POST", Pattern: "/api/conversations/:id/restore", Auth: authz.Owner, handle: (*Server).restoreConversation},
	{Method: "POST", Pattern: "/api/conversations/:id/participants", Auth: authz.Human, Lease: true, handle: (*Server).addParticipant},
	{Method: "POST", Pattern: "/api/conversations/:id/participants/:iid/approve", Auth: authz.Human, handle: decideParticipant(true)},
	{Method: "POST", Pattern: "/api/conversations/:id/participants/:iid/decline", Auth: authz.Human, handle: decideParticipant(false)},
	{Method: "DELETE", Pattern: "/api/conversations/:id/participants/:iid", Auth: authz.Human, Lease: true, handle: (*Server).removeParticipant},
	{Method: "POST", Pattern: "/api/conversations/:id/join-requests", Auth: authz.Lease, handle: (*Server).requestJoin},
	{Method: "POST", Pattern: "/api/conversations/:id/leave", Auth: authz.Human, Lease: true, handle: (*Server).leaveConversation},
}
