package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// coreRoutes are the routes of health, version, the web app pages and its static files. Only the work package that owns this module edits this file.
var coreRoutes = []Route{
	{Method: "GET", Pattern: "/healthz", Auth: authz.Pub, handle: (*Server).health},
	{Method: "GET", Pattern: "/api/version", Auth: authz.Pub, handle: (*Server).version},
	// Pages: the web app (console.Page) at every screen URL. A signed-in page sends a caller with no session to sign in.
	{Method: "GET", Pattern: "/bootstrap", Auth: authz.Pub, handle: appPage},
	{Method: "GET", Pattern: "/signin", Auth: authz.Pub, handle: appPage},
	{Method: "GET", Pattern: "/recover", Auth: authz.Pub, handle: appPage},
	{Method: "GET", Pattern: "/", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/chats", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/chats/new", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/chats/:id", Auth: authz.Human, Page: true, handle: (*Server).chatPage},
	{Method: "GET", Pattern: "/crew", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/crew/machines", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/crew/:handle", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/onboarding", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/settings/passkeys", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/settings/recovery", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/account", Auth: authz.Human, Page: true, handle: appPage},
	{Method: "GET", Pattern: "/trash", Auth: authz.Human, Page: true, handle: appPage},
	// The app's hashed build files (cached for a year), and the public files that keep their names.
	{Method: "GET", Pattern: "/assets/:file", Auth: authz.Pub, handle: appAsset},
	{Method: "GET", Pattern: "/assets/lookalikes.js", Auth: authz.Pub, handle: lookalikesAsset},
	{Method: "GET", Pattern: "/assets/icon-192.png", Auth: authz.Pub, handle: file("assets/icon-192.png", "image/png")},
	{Method: "GET", Pattern: "/assets/icon-512.png", Auth: authz.Pub, handle: file("assets/icon-512.png", "image/png")},
	{Method: "GET", Pattern: "/fonts/OFL.txt", Auth: authz.Pub, handle: file("fonts/OFL.txt", "text/plain; charset=utf-8")},
	{Method: "GET", Pattern: "/favicon.ico", Auth: authz.Pub, handle: file("favicon.ico", "image/vnd.microsoft.icon")},
	{Method: "GET", Pattern: "/apple-touch-icon.png", Auth: authz.Pub, handle: file("apple-touch-icon.png", "image/png")},
	{Method: "GET", Pattern: "/manifest.webmanifest", Auth: authz.Pub, handle: file("manifest.webmanifest", "application/manifest+json")},
	// The service worker: at the root so its scope is the whole app; never cached, so a new build's worker is seen at once.
	{Method: "GET", Pattern: "/sw.js", Auth: authz.Pub, handle: file("sw.js", "text/javascript; charset=utf-8")},
}
