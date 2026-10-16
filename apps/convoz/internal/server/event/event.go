// Package event owns the append-only events table (I-4). S1 only appends; readers arrive with sync.
package event

import (
	"context"
	"encoding/json"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event/db"
)

// Append writes one event with a JSON payload of ids and enums, inside the caller's transaction.
func Append(ctx context.Context, q *db.Queries, now time.Time, typ string, payload any) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	return q.AppendEvent(ctx, db.AppendEventParams{Type: typ, Payload: string(raw), CreatedAt: now.UnixMilli()})
}
