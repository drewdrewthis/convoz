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
// readAll lets the read-all right count: for reading a message's history and for the one write a read-all agent may do in a
// conversation it is not in, posting a message.
type conversationPort struct {
	p       authz.Principal
	readAll bool
}

func (a conversationPort) Access(ctx context.Context, d pdb.DBTX, conv int64) (message.Access, error) {
	_, found, err := conversation.Get(ctx, d, conv)
	if err != nil {
		return message.Denied, err
	}
	see := canSee
	if a.readAll {
		see = canRead
	}
	_, visible, err := see(ctx, d, a.p, conv)
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

// RecordMainPost moves the counters, then brings in the agents a person's message @mentions (I-18); an agent's @mention
// never adds anyone. The loop breaker is not here: message.Post counts every post toward it (I-16).
func (a conversationPort) RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64, body string) (int64, error) {
	prev, err := conversation.RecordMainPost(ctx, d, now, conv, messageID, body)
	if err != nil || a.p.SessionID != 0 {
		return prev, err
	}
	m, ok, err := message.Get(ctx, d, messageID)
	if err != nil || !ok {
		return prev, err
	}
	skip := int64(0)
	if m.AnswersAskID != 0 {
		if ask, found, err := message.GetAny(ctx, d, m.AnswersAskID); err != nil {
			return prev, err
		} else if found {
			skip = ask.AuthorID
		}
	}
	return prev, addMentioned(ctx, d, now, conv, a.p.Identity(), messageID, skip, message.ParseMentions(m.Body, m.Format))
}

func (conversationPort) NoteAgentPost(ctx context.Context, d pdb.DBTX, conv, author, session int64) error {
	return conversation.NoteAgentPost(ctx, d, conv, author, session)
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
