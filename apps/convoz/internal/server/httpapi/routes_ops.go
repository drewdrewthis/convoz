package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// opsRoutes are the routes of export, delete, purge and the web app's error reports. Only the work package that owns this module edits this file.
var opsRoutes = []Route{
	{Method: "GET", Pattern: "/settings/export", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/settings/delete", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "POST", Pattern: "/api/me/export", Auth: authz.Human, StepUp: "data.export", RefuseLease: true, handle: (*Server).startExport},
	{Method: "POST", Pattern: "/api/me/delete", Auth: authz.Human, StepUp: "data.delete", RefuseLease: true, handle: (*Server).deleteMyData},
	{Method: "GET", Pattern: "/api/me/export/:id", Auth: authz.Human, RefuseLease: true, handle: (*Server).getExport},
	{Method: "POST", Pattern: "/api/client-errors", Auth: authz.Owner, handle: (*Server).clientError},
}
