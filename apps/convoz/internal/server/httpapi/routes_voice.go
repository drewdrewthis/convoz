package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// voiceRoutes are the routes of the voice call. RefuseLease: an agent never gets a token.
var voiceRoutes = []Route{
	{Method: "GET", Pattern: "/api/voice", Auth: authz.Owner, RefuseLease: true, handle: (*Server).getVoice},
	{Method: "POST", Pattern: "/api/voice/token", Auth: authz.Owner, RefuseLease: true, handle: (*Server).voiceToken},
}
