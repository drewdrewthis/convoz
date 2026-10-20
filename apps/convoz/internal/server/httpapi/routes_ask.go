package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// askRoutes are the routes of asks and Now. Only the work package that owns this module edits this file.
// An ask is asked and withdrawn with a lease, answered, dismissed and snoozed by a person; a lease that tries a person's
// route is told 403 (C-3), a person that tries an agent's is told 403 in the handler.
var askRoutes = []Route{
	{Method: "GET", Pattern: "/api/now", Auth: authz.Human, RefuseLease: true, handle: (*Server).nowScreen},
	{Method: "POST", Pattern: "/api/asks", Auth: authz.Human, Lease: true, Scope: "ask", handle: (*Server).postAsk},
	{Method: "GET", Pattern: "/api/asks/:id", Auth: authz.Human, Lease: true, handle: (*Server).getAsk},
	{Method: "PATCH", Pattern: "/api/asks/:id", Auth: authz.Human, Lease: true, Scope: "ask", handle: (*Server).askUpdate},
	{Method: "POST", Pattern: "/api/asks/:id/answer", Auth: authz.Human, RefuseLease: true, handle: (*Server).askAnswer},
	{Method: "POST", Pattern: "/api/asks/:id/dismiss", Auth: authz.Human, RefuseLease: true, handle: (*Server).askDismiss},
	{Method: "POST", Pattern: "/api/asks/:id/undismiss", Auth: authz.Human, RefuseLease: true, handle: (*Server).askUndismiss},
	{Method: "POST", Pattern: "/api/asks/:id/withdraw", Auth: authz.Human, Lease: true, handle: (*Server).askWithdraw},
	{Method: "PUT", Pattern: "/api/asks/:id/snooze", Auth: authz.Human, RefuseLease: true, handle: (*Server).askSnooze},
	{Method: "DELETE", Pattern: "/api/asks/:id/snooze", Auth: authz.Human, RefuseLease: true, handle: (*Server).askUnsnooze},
}
