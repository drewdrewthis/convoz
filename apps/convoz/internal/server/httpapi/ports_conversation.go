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

// RecordMainPost moves the counters, then applies what the post means for the conversation: an agent's message counts
// toward the loop breaker (the 20th in a row pauses the conversation, I-16), a person's resets it and may bring in the
// agents it @mentions (I-18). An agent's @mention never adds anyone.
func (a conversationPort) RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64, body string) (int64, error) {
	prev, err := conversation.RecordMainPost(ctx, d, now, conv, messageID, body)
	if err != nil {
		return 0, err
	}
	if a.p.SessionID != 0 {
		paused, err := conversation.AgentPosted(ctx, d, now, conv)
		if err != nil || !paused {
			return prev, err
		}
		_, _, err = sayLine(ctx, d, now, a.p.Identity(), conv, "Agents are paused after 20 messages in a row.", "conversation.paused", nil)
		return prev, err
	}
	if _, err := conversation.HumanPosted(ctx, d, conv); err != nil {
		return 0, err
	}
	return prev, addMentioned(ctx, d, now, conv, a.p.Identity(), messageID, body)
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
