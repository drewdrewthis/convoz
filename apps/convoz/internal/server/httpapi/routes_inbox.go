package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// inboxRoutes are the routes of the agent inbox and handoffs. Only the work package that owns this module edits this file.
var inboxRoutes = []Route{
	{Method: "GET", Pattern: "/api/inbox", Auth: authz.Lease, handle: (*Server).inboxPoll},
	{Method: "POST", Pattern: "/api/inbox/claim", Auth: authz.Lease, handle: (*Server).claimInbox},
	{Method: "POST", Pattern: "/api/inbox/ack", Auth: authz.Lease, handle: (*Server).ackInbox},
}
