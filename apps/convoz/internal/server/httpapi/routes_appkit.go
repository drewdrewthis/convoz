package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// appkitRoutes are the routes of apps. Only the work package that owns this module edits this file.
// The frame opens for the owner's browser only (a lease is told 403, I-46). The bundle route and the file route are the
// stand-in of the upload module: when kind `app` and `image` uploads land, they go (see migration 0018).
var appkitRoutes = []Route{
	{Method: "POST", Pattern: "/api/apps/validate", Auth: authz.Human, Lease: true, handle: (*Server).validateApp},
	{Method: "POST", Pattern: "/api/apps/bundles", Auth: authz.Human, Lease: true, handle: (*Server).putAppBundle},
	{Method: "GET", Pattern: "/api/messages/:id/app", Auth: authz.Human, Lease: true, handle: (*Server).getMessageApp},
	{Method: "GET", Pattern: "/api/apps/:message_id/frame", Auth: authz.Human, RefuseLease: true, handle: (*Server).getAppFrame},
	{Method: "GET", Pattern: "/api/files/:public_id", Auth: authz.Human, Lease: true, handle: (*Server).getAppFile},
}
