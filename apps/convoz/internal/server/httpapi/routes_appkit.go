package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// appkitRoutes are the routes of apps. Only the work package that owns this module edits this file.
// The frame opens for the owner's browser only (a lease is told 403, I-46). The bundle and the gallery images of an app are
// uploads of kind `app` and `image` (routes_upload.go).
var appkitRoutes = []Route{
	{Method: "POST", Pattern: "/api/apps/validate", Auth: authz.Human, Lease: true, handle: (*Server).validateApp},
	{Method: "GET", Pattern: "/api/messages/:id/app", Auth: authz.Human, Lease: true, handle: (*Server).getMessageApp},
	{Method: "GET", Pattern: "/api/apps/:message_id/frame", Auth: authz.Human, RefuseLease: true, handle: (*Server).getAppFrame},
}
