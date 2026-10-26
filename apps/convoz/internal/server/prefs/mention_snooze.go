package prefs

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs/db"
)

// MentionSnooze is a person's "Later" on the mention card of one conversation: the card stays hidden until Until (epoch ms), unless
// a mention newer than AfterID arrives first.
type MentionSnooze struct {
	Until, AfterID int64
}

// SnoozeMentions sets (or moves) the person's Later on a conversation. afterID is the newest message of it now.
func SnoozeMentions(ctx context.Context, d pdb.DBTX, identityID, conversationID, until, afterID int64) error {
	return db.New(d).UpsertMentionSnooze(ctx, db.UpsertMentionSnoozeParams{IdentityID: identityID, ConversationID: conversationID, UntilAt: until, AfterID: afterID})
}

// MentionSnoozes reads the person's Laters that have not run out at now, by conversation.
func MentionSnoozes(ctx context.Context, d pdb.DBTX, identityID int64, now time.Time) (map[int64]MentionSnooze, error) {
	rows, err := db.New(d).ListMentionSnoozes(ctx, db.ListMentionSnoozesParams{IdentityID: identityID, Now: now.UnixMilli()})
	if err != nil {
		return nil, err
	}
	out := make(map[int64]MentionSnooze, len(rows))
	for _, r := range rows {
		out[r.ConversationID] = MentionSnooze{Until: r.UntilAt, AfterID: r.AfterID}
	}
	return out, nil
}
