// Package event owns the append-only events table (I-4, I-23): thin facts of ids and enums, in the transaction of
// the change they describe. Readers (the SSE stream) hydrate from state rows; an event never carries a body or a title.
package event

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Version is appended to every event name on write: callers say "message.created", the log stores "message.created.v1".
const Version = ".v1"

// Epoch names this log in a stream id (`<epoch>:<seq>`). It changes only if the log is ever rebuilt or restored.
const Epoch = "1"

// Entry is one event to write. A zero id means none.
type Entry struct {
	Type         string // without the version
	Actor        int64
	Session      int64
	Conversation int64
	Audience     int64 // set when only one identity may see the event (a read cursor move)
	Message      int64
	// IdemKey makes the write a retry-safe command with the actor: one event per (actor, key).
	IdemKey string
	Payload any // ids and enums only; at most 1024 bytes as JSON
}

// Event is one stored row.
type Event struct {
	Seq          int64
	Type         string // with the version
	Actor        int64
	Session      int64
	Conversation int64
	Audience     int64
	Message      int64
	Payload      string
	CreatedAt    int64
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

// Write appends e inside the caller's transaction and returns its seq.
func Write(ctx context.Context, d pdb.DBTX, now time.Time, e Entry) (int64, error) {
	raw, err := json.Marshal(e.Payload)
	if err != nil {
		return 0, err
	}
	if e.Payload == nil {
		raw = []byte("{}")
	}
	return db.New(d).AppendEvent(ctx, db.AppendEventParams{
		Type: e.Type + Version, ActorID: nullInt(e.Actor), SessionID: nullInt(e.Session), ConversationID: nullInt(e.Conversation),
		AudienceID: nullInt(e.Audience), MessageID: nullInt(e.Message), PayloadJson: string(raw),
		IdemKey:   sql.NullString{String: e.IdemKey, Valid: e.IdemKey != ""},
		CreatedAt: now.UnixMilli(),
	})
}

// Append writes an event that has no actor, conversation or message: the account and machine events of S1.
func Append(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload any) (int64, error) {
	if previousRelease() {
		return appendS1(ctx, d, now, typ, payload)
	}
	return Write(ctx, d, now, Entry{Type: typ, Payload: payload})
}

// previousRelease is true only in a test build capped before migration 7, which plays the S1b release: its events
// table still has the old shape, so the migration test can start from rows that release wrote. A release build never is.
func previousRelease() bool {
	cap := platform.MaxMigrationCap()
	return cap > 0 && cap < 7
}

// appendS1 writes an event as S1b did, into the table as it was before migration 7: no version on the type.
func appendS1(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload any) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var id int64
	err = d.QueryRowContext(ctx, "INSERT INTO events (type, payload, created_at) VALUES (?1, ?2, ?3) RETURNING id", typ, string(raw), now.UnixMilli()).Scan(&id)
	return id, err
}

// Since returns up to limit events with seq > after, oldest first.
func Since(ctx context.Context, d pdb.DBTX, after int64, limit int) ([]Event, error) {
	rows, err := db.New(d).EventsSince(ctx, db.EventsSinceParams{After: after, MaxRows: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(rows))
	for _, r := range rows {
		out = append(out, Event{
			Seq: r.Seq, Type: r.Type, Actor: r.ActorID.Int64, Session: r.SessionID.Int64, Conversation: r.ConversationID.Int64,
			Audience: r.AudienceID.Int64, Message: r.MessageID.Int64, Payload: r.PayloadJson, CreatedAt: r.CreatedAt,
		})
	}
	return out, nil
}

// MaxSeq is the newest seq, 0 for an empty log.
func MaxSeq(ctx context.Context, d pdb.DBTX) (int64, error) {
	return db.New(d).MaxEventSeq(ctx)
}

// FindIdem returns the conversation of the event written for (actor, key); ok is false when there is none.
func FindIdem(ctx context.Context, d pdb.DBTX, actor int64, key string) (conversation int64, ok bool, err error) {
	r, err := db.New(d).EventByIdem(ctx, db.EventByIdemParams{ActorID: nullInt(actor), IdemKey: sql.NullString{String: key, Valid: true}})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return r.ConversationID.Int64, err == nil, err
}
