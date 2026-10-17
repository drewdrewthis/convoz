package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// conversationPort answers for the conversation module and for who may post in it.
type conversationPort struct{ p authz.Principal }

func (a conversationPort) Access(ctx context.Context, d pdb.DBTX, conv int64) (message.Access, error) {
	_, found, err := conversation.Get(ctx, d, conv)
	if err != nil {
		return message.Denied, err
	}
	_, visible, err := canSee(ctx, d, a.p, conv)
	switch {
	case err != nil:
		return message.Denied, err
	case visible:
		return message.Allowed, nil
	case !found && a.p.SessionID == 0:
		return message.Missing, nil
	}
	return message.Denied, nil // an agent is told 403 whether or not the conversation exists
}

func (conversationPort) RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64, body string) (int64, error) {
	return conversation.RecordMainPost(ctx, d, now, conv, messageID, body)
}

func (conversationPort) AgentRecipients(ctx context.Context, d pdb.DBTX, conv, author int64) ([]int64, error) {
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	parts, err := conversation.Participants(ctx, d, conv)
	if err != nil {
		return nil, err
	}
	var out []int64
	for _, pt := range parts {
		if e := dir[pt.IdentityID]; e.Kind == "agent" && !e.Disabled && pt.IdentityID != author {
			out = append(out, pt.IdentityID)
		}
	}
	return out, nil
}
