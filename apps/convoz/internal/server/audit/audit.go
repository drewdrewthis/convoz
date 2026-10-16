// Package audit owns the audit table: who did what, written in the same transaction as the action.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit/db"
)

// Entry is one thing to record. Detail holds ids and enums only, never a secret.
type Entry struct {
	Actor      int64 // identity id; 0 for none
	Device     int64 // device id; 0 for none
	Action     string
	TargetKind string
	TargetID   int64
	Detail     map[string]any
}

// Row is one audit row as the admin view lists it.
type Row struct {
	ID         int64           `json:"id"`
	At         int64           `json:"at"`
	ActorID    *int64          `json:"actor_id"`
	DeviceID   *int64          `json:"device_id"`
	Action     string          `json:"action"`
	TargetKind *string         `json:"target_kind"`
	TargetID   *int64          `json:"target_id"`
	Detail     json.RawMessage `json:"detail,omitempty"`
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

// Write records e. Call it inside the transaction of the action it describes.
func Write(ctx context.Context, q *db.Queries, now time.Time, e Entry) error {
	p := db.InsertAuditParams{
		At:         now.UnixMilli(),
		ActorID:    nullInt(e.Actor),
		DeviceID:   nullInt(e.Device),
		Action:     e.Action,
		TargetKind: sql.NullString{String: e.TargetKind, Valid: e.TargetKind != ""},
		TargetID:   nullInt(e.TargetID),
	}
	if len(e.Detail) > 0 {
		raw, err := json.Marshal(e.Detail)
		if err != nil {
			return err
		}
		p.DetailJson = sql.NullString{String: string(raw), Valid: true}
	}
	return q.InsertAudit(ctx, p)
}

// List returns the newest rows first, at most max.
func List(ctx context.Context, q *db.Queries, max int) ([]Row, error) {
	rows, err := q.ListAudit(ctx, int64(max))
	if err != nil {
		return nil, err
	}
	out := make([]Row, 0, len(rows))
	for _, r := range rows {
		row := Row{ID: r.ID, At: r.At, Action: r.Action}
		if r.ActorID.Valid {
			row.ActorID = &r.ActorID.Int64
		}
		if r.DeviceID.Valid {
			row.DeviceID = &r.DeviceID.Int64
		}
		if r.TargetKind.Valid {
			row.TargetKind = &r.TargetKind.String
		}
		if r.TargetID.Valid {
			row.TargetID = &r.TargetID.Int64
		}
		if r.DetailJson.Valid {
			row.Detail = json.RawMessage(r.DetailJson.String)
		}
		out = append(out, row)
	}
	return out, nil
}
