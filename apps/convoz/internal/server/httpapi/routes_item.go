package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// itemRoutes are the routes of feed items. An agent moves its own items with a lease, one call per transition; the owner acts with a device.
var itemRoutes = []Route{
	{Method: "POST", Pattern: "/api/conversations/:id/items/:key/:event", Auth: authz.Lease, Scope: "status", handle: (*Server).postItem},
	{Method: "POST", Pattern: "/api/messages/:id/take", Auth: authz.Lease, Scope: "status", handle: (*Server).postTake},
	{Method: "GET", Pattern: "/api/feed", Auth: authz.Owner, RefuseLease: true, handle: (*Server).getFeed},
	{Method: "POST", Pattern: "/api/feed/:id/accept", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedAccept},
	{Method: "POST", Pattern: "/api/feed/:id/answer", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedAnswer},
	{Method: "POST", Pattern: "/api/feed/:id/reply", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedReply},
	{Method: "POST", Pattern: "/api/feed/:id/ack", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedAck},
	{Method: "PUT", Pattern: "/api/feed/:id/snooze", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedSnooze},
	{Method: "DELETE", Pattern: "/api/feed/:id/snooze", Auth: authz.Owner, RefuseLease: true, handle: (*Server).feedUnsnooze},
}
