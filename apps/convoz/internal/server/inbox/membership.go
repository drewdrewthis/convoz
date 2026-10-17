package inbox

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Mention records that a message @mentioned the agent: the ready item of the conversation becomes a mention.
func Mention(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64) error {
	return db.New(d).UpsertMentionItem(ctx, db.UpsertMentionItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// Joined tells an agent how a seat change that concerns it ended: a person added it, or approved or declined an add it asked for
// (or an add of it that another agent asked for). The message is the system line that says so. One item per change.
func Joined(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64) error {
	return db.New(d).InsertMembershipItem(ctx, db.InsertMembershipItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// Removed ends the agent's standing in a conversation as far as its inbox goes (I-19): its other waiting items for
// the conversation expire and ONE membership notice is queued, which is delivered once and is exempt from the
// can-see check, since the agent can no longer see the conversation. messageID is the system line that says it.
func Removed(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64) error {
	q := db.New(d)
	if _, err := q.ExpireConversationItems(ctx, db.ExpireConversationItemsParams{Now: now.UnixMilli(), IdentityID: identityID, ConversationID: nullInt(conversationID)}); err != nil {
		return err
	}
	return q.InsertMembershipItem(ctx, db.InsertMembershipItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// Left expires the agent's waiting items for a conversation it left itself; it needs no notice.
func Left(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID int64) error {
	_, err := db.New(d).ExpireConversationItems(ctx, db.ExpireConversationItemsParams{Now: now.UnixMilli(), IdentityID: identityID, ConversationID: nullInt(conversationID)})
	return err
}
