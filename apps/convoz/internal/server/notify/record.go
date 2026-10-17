package notify

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Suppressed is a trigger that was decided against sending, with why (design §10.2). It is the log row; no push goes out.
type Suppressed struct {
	Identity     int64
	Reason       string // the trigger: mention, ask, ...
	Why          string // suppressed_reason: muted, quiet_hours, ...
	SourceSeq    int64  // what the trigger came from; with Identity and Reason it makes the row unique
	Conversation int64
	Message      int64
}

// topic is the opaque thread key of a conversation for one person (I-28): a hash, so the log and the push service never see a title or id.
func topic(identity, conversation int64) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "topic:%d:%d", identity, conversation))
	return hex.EncodeToString(sum[:16])
}

// RecordSuppressed writes a suppressed notification inside the caller's transaction.
func RecordSuppressed(ctx context.Context, d pdb.DBTX, now time.Time, s Suppressed) error {
	return db.New(d).InsertSuppressed(ctx, db.InsertSuppressedParams{
		IdentityID: s.Identity, Reason: s.Reason, SourceSeq: s.SourceSeq, ConversationID: sql.NullInt64{Int64: s.Conversation, Valid: s.Conversation != 0},
		MessageID: sql.NullInt64{Int64: s.Message, Valid: s.Message != 0}, Topic: topic(s.Identity, s.Conversation), SuppressedReason: sql.NullString{String: s.Why, Valid: true}, At: now.UnixMilli(),
	})
}

// Logged is one row of the notification log.
type Logged struct {
	ID, Identity          int64
	Reason, Decision, Why string
	Conversation, Message int64
}

// maxLogged bounds one read of the log.
const maxLogged = 500

// Log reads the newest rows of the notification log, oldest first.
func Log(ctx context.Context, d pdb.DBTX) ([]Logged, error) {
	rows, err := db.New(d).ListNotifications(ctx, maxLogged)
	if err != nil {
		return nil, err
	}
	out := make([]Logged, 0, len(rows))
	for _, r := range rows {
		out = append(out, Logged{ID: r.ID, Identity: r.IdentityID, Reason: r.Reason, Decision: r.Decision, Why: r.SuppressedReason.String, Conversation: r.ConversationID.Int64, Message: r.MessageID.Int64})
	}
	return out, nil
}
