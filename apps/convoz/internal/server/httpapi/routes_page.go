package httpapi

import (
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// pageRoutes are the routes of page sharing (page-share.feature): the owner's extension shares a tab and answers, the agents of
// the conversation ask. Every one answers 404 unless the server names the extension (--extension-origin).
var pageRoutes = []Route{
	{Method: "POST", Pattern: wire.RoutePageShares, Auth: authz.Human, handle: (*Server).startPageShare},
	{Method: "DELETE", Pattern: wire.RoutePageShares + "/:id", Auth: authz.Human, handle: (*Server).stopPageShare},
	{Method: "GET", Pattern: wire.RoutePageShares + "/:id/next", Auth: authz.Human, handle: (*Server).nextPageRequest},
	{Method: "POST", Pattern: wire.RoutePageRequests + "/:id/result", Auth: authz.Human, handle: (*Server).answerPageRequest},
	{Method: "GET", Pattern: wire.RoutePageShares, Auth: authz.Lease, handle: (*Server).listPageShares},
	{Method: "POST", Pattern: wire.RoutePageRequests, Auth: authz.Lease, Scope: "page", handle: (*Server).askPage},
}
