package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// uploadRoutes are the routes of uploads and files. Only the work package that owns this module edits this file.
var uploadRoutes = []Route{
	{Method: "POST", Pattern: "/api/uploads", Auth: authz.Human, Lease: true, Scope: "upload", handle: (*Server).createUpload},
	{Method: "PATCH", Pattern: "/api/uploads/:id", Auth: authz.Human, Lease: true, Scope: "upload", handle: (*Server).patchUpload},
	{Method: "HEAD", Pattern: "/api/uploads/:id", Auth: authz.Human, Lease: true, Scope: "upload", handle: (*Server).headUpload},
	{Method: "GET", Pattern: "/api/files/:public_id", Auth: authz.Human, Lease: true, Scope: "read", handle: (*Server).getFile},
}
