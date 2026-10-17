package notify

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Reasons of a notification (design §10.1).
const ReasonSnoozeWake = "snooze_wake"

// SnoozeWoke records the notification a woken snooze causes for one person. Until the push pipeline (consumer C2) exists
// there is no subscription to send to, so the row says it was held back for that reason; the pipeline replaces this call
// with its own decision. The topic is a placeholder hash of the ask, not yet the keyed HMAC of design §10.3.
func SnoozeWoke(ctx context.Context, d pdb.DBTX, now time.Time, person, conversationID, askMessageID, sourceSeq int64) error {
	sum := sha256.Sum256([]byte("a" + strconv.FormatInt(askMessageID, 10)))
	return db.New(d).InsertNotification(ctx, db.InsertNotificationParams{
		IdentityID: person, Reason: ReasonSnoozeWake, SourceSeq: sourceSeq,
		ConversationID: sql.NullInt64{Int64: conversationID, Valid: conversationID != 0},
		MessageID:      sql.NullInt64{Int64: askMessageID, Valid: askMessageID != 0},
		Topic:          hex.EncodeToString(sum[:])[:22], Urgent: 0, Decision: "suppressed",
		SuppressedReason: sql.NullString{String: "no_subscription", Valid: true}, Now: now.UnixMilli(),
	})
}
