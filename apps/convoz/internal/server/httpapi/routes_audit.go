package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// auditRoutes are the routes of the audit log. Only the work package that owns this module edits this file.
var auditRoutes = []Route{
	{Method: "GET", Pattern: "/api/admin/audit", Auth: authz.Owner, handle: (*Server).auditList},
}
