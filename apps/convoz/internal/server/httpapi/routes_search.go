package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// searchRoutes are the routes of search. Only the work package that owns this module edits this file.
var searchRoutes = []Route{
	{Method: "GET", Pattern: "/api/search", Auth: authz.Human, Lease: true, handle: (*Server).search},
}
