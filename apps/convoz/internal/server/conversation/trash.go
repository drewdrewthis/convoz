package conversation

import (
	"context"
	"database/sql"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Retention of deleted and empty conversations.
const (
	TrashRetention = 30 * 24 * time.Hour
	EmptyAfter     = 24 * time.Hour
)

func nullAt(t time.Time) sql.NullInt64 { return sql.NullInt64{Int64: t.UnixMilli(), Valid: true} }

// Delete moves a conversation to the trash (soft delete, I-49). It reports false when there was nothing to delete.
func Delete(ctx context.Context, d pdb.DBTX, now time.Time, conv, human int64) (bool, error) {
	n, err := db.New(d).SoftDelete(ctx, db.SoftDeleteParams{At: nullAt(now), By: sql.NullInt64{Int64: human, Valid: true}, ID: conv})
	return n > 0, err
}

// Restore brings a conversation back from the trash with all its messages. It reports false when it was not in the trash.
func Restore(ctx context.Context, d pdb.DBTX, conv int64) (bool, error) {
	n, err := db.New(d).Restore(ctx, conv)
	return n > 0, err
}

// Trash lists the deleted conversations, newest deletion first.
func Trash(ctx context.Context, d pdb.DBTX) ([]Conversation, error) {
	rows, err := db.New(d).ListTrash(ctx, MaxListed)
	return fromRows(rows), err
}

// PurgeTrash removes the conversations that have been in the trash for over 30 days, with everything that hangs off
// them. It returns how many went.
func PurgeTrash(ctx context.Context, d pdb.DBTX, now time.Time) (int64, error) {
	return db.New(d).PurgeTrashBefore(ctx, nullAt(now.Add(-TrashRetention)))
}

// CleanEmpty removes the conversations that nobody wrote in for over 24 hours and that have no chosen title (I-20).
// isStarred lets the caller keep one the owner starred (stars belong to the prefs module). Each delete re-checks its
// conditions in its own statement, so a message that lands at this moment keeps the conversation. It returns how many went.
func CleanEmpty(ctx context.Context, d pdb.DBTX, now time.Time, isStarred func(conv int64) (bool, error)) (int, error) {
	q := db.New(d)
	cutoff := now.Add(-EmptyAfter).UnixMilli()
	ids, err := q.EmptyUntitledIDs(ctx, db.EmptyUntitledIDsParams{Before: cutoff, MaxRows: 500})
	if err != nil {
		return 0, err
	}
	gone := 0
	for _, id := range ids {
		if starred, err := isStarred(id); err != nil {
			return gone, err
		} else if starred {
			continue
		}
		n, err := q.DeleteEmptyConversation(ctx, db.DeleteEmptyConversationParams{ID: id, Before: cutoff})
		if err != nil {
			return gone, err
		}
		gone += int(n)
	}
	return gone, nil
}

// AgentCreatedSince counts the conversations an identity made since the cutoff (the daily cap of an agent).
func AgentCreatedSince(ctx context.Context, d pdb.DBTX, who int64, since time.Time) (int64, error) {
	return db.New(d).CountAgentConversationsSince(ctx, db.CountAgentConversationsSinceParams{CreatedBy: who, Since: since.UnixMilli()})
}

// AddOpenAsks corrects the conversation's open-ask counter after asks were closed outside the ask flow.
func AddOpenAsks(ctx context.Context, d pdb.DBTX, conv, delta int64) error {
	return db.New(d).AddOpenAsks(ctx, db.AddOpenAsksParams{Delta: delta, ID: conv})
}
