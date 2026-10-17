package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// opsRoutes are the routes of export, delete and purge. Only the work package that owns this module edits this file.
var opsRoutes = []Route{
	{Method: "GET", Pattern: "/settings/export", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "POST", Pattern: "/api/me/export", Auth: authz.Human, StepUp: "data.export", RefuseLease: true, handle: (*Server).startExport},
	{Method: "GET", Pattern: "/api/me/export/:id", Auth: authz.Human, RefuseLease: true, handle: (*Server).getExport},
}
