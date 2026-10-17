package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// messagePorts wires message.Post to the other modules for the caller p. Each port lives in the file of the module that
// implements it (ports_<module>.go); a module that is not built yet has a no-op there, which its work package replaces.
func messagePorts(p authz.Principal) message.Ports {
	return message.Ports{
		Conversations: conversationPort{p}, Reads: readsPort{}, Inbox: inboxPort{}, Journal: messageJournal{},
		Search: searchPort{}, Uploads: uploadPort{}, Apps: appPort{}, Mentions: mentionsPort{}, Unfurls: unfurlPort{}, Audit: postAuditPort{},
	}
}

// mentionsPort records mentions. No-op until the message work package parses them.
type mentionsPort struct{}

func (mentionsPort) RecordMentions(context.Context, pdb.DBTX, time.Time, message.Message) ([]int64, error) {
	return nil, nil
}
