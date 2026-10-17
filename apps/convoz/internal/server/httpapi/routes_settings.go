package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// settingsRoutes are the routes of settings: the registry API, the two settings pages and the boot script. Only the work package
// that owns this module edits this file.
var settingsRoutes = []Route{
	{Method: "GET", Pattern: "/api/settings", Auth: authz.Human, handle: (*Server).getSettings},
	{Method: "PATCH", Pattern: "/api/settings", Auth: authz.Human, handle: (*Server).patchSettings},
	{Method: "GET", Pattern: "/settings", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/settings/privacy", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/assets/settings/theme-boot.js", Auth: authz.Pub, handle: themeBootAsset},
}
