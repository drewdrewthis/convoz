package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// askRoutes are the routes of asks and Now. Only the work package that owns this module edits this file.
var askRoutes = []Route{
	{Method: "GET", Pattern: "/api/now", Auth: authz.Owner, handle: (*Server).now},
}
