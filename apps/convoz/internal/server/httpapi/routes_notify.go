package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// notifyRoutes are the routes of push notifications. Only the work package that owns this module edits this file.
// They are a person's own device session (never a lease, never the limited recovery session).
var notifyRoutes = []Route{
	{Method: "GET", Pattern: "/api/push/vapid-key", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushVapidKey},
	{Method: "GET", Pattern: "/api/push/subscriptions", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushList},
	{Method: "POST", Pattern: "/api/push/subscriptions", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushSubscribe},
	{Method: "DELETE", Pattern: "/api/push/subscriptions", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushUnsubscribe},
	{Method: "POST", Pattern: "/api/push/test", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushTest},
	{Method: "PUT", Pattern: "/api/push/focus", Auth: authz.Human, RefuseLease: true, handle: (*Server).pushFocus},
}
