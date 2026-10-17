package httpapi

import (
	"context"
	"regexp"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// inboxPort queues a new message for one agent with the strongest reason it gives (C-10).
type inboxPort struct{}

func (inboxPort) FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error {
	reason, err := reasonFor(ctx, d, identity, messageID)
	if err != nil {
		return err
	}
	return inbox.FanOut(ctx, d, now, identity, conv, messageID, sourceSeq, reason)
}

// reasonFor is "mention" when the message names the agent, else "activity".
//
// Stopgap: the message module will record mentions in its own table (the Mentions port); then this reads that
// table, and thread replies give "thread". Until then the body is the only record of who is named.
func reasonFor(ctx context.Context, d pdb.DBTX, identity, messageID int64) (string, error) {
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return "", err
	}
	m, found, err := message.Get(ctx, d, messageID)
	if err != nil || !found {
		return inbox.ReasonActivity, err
	}
	if mentions(m.Body, dir[identity].Handle) {
		return inbox.ReasonMention, nil
	}
	return inbox.ReasonActivity, nil
}

// mentions reports whether body names @handle as a whole word (a handle may hold "-").
func mentions(body, handle string) bool {
	if handle == "" {
		return false
	}
	return regexp.MustCompile(`(?i)(^|[^\w])@` + regexp.QuoteMeta(handle) + `($|[^\w-])`).MatchString(body)
}
