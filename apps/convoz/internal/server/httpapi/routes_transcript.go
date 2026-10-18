package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// transcriptRoutes are the routes of transcripts. Only the work package that owns this module edits this file.
var transcriptRoutes = []Route{
	{Method: "POST", Pattern: "/api/uploads/:id/transcribe", Auth: authz.Owner, handle: (*Server).transcribeAgain},
}
