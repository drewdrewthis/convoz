package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// messageRoutes are the routes of messages. Only the work package that owns this module edits this file.
var messageRoutes = []Route{
	{Method: "GET", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, handle: (*Server).listMessages},
	{Method: "POST", Pattern: "/api/conversations/:id/messages", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).postMessage},
	{Method: "POST", Pattern: "/api/conversations/:id/typing", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).typing},
	{Method: "PATCH", Pattern: "/api/messages/:id", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).editMessage},
	{Method: "DELETE", Pattern: "/api/messages/:id", Auth: authz.Human, Lease: true, Scope: "post", handle: (*Server).deleteMessage},
	{Method: "GET", Pattern: "/api/messages/:id/edits", Auth: authz.Human, Lease: true, handle: (*Server).listEdits},
	{Method: "POST", Pattern: "/api/messages/:id/purge", Auth: authz.Owner, StepUp: "message.purge", RefuseLease: true, handle: (*Server).purgeMessage},
}
