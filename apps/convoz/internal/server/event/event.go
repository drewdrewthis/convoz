// Package event owns the append-only events table (I-4, I-23): thin facts of ids and enums, in the transaction of
// the change they describe. Readers (the SSE stream) hydrate from state rows; an event never carries a body or a title.
package event

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// The versioned names of the events the chat writes. Callers and readers use the full name, `.vN` included.
const (
	MessageCreated      = "message.created.v1"
	ReadMoved           = "read.moved.v1"
	ConversationCreated = "conversation.created.v1"
)

// ErrBadType means an event name that does not end in `.vN`.
var ErrBadType = errors.New("event type must end in .vN, for example message.created.v1")

var versioned = regexp.MustCompile(`^[a-z][a-z_.]*\.v[0-9]+$`)

// Epoch names this log in a stream id (`<epoch>:<seq>`). It changes only if the log is ever rebuilt or restored.
const Epoch = "1"

// Entry is one event to write. A zero id means none.
type Entry struct {
	Type         string // the full versioned name, e.g. "message.created.v1"
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
	if !versioned.MatchString(e.Type) {
		return 0, ErrBadType
	}
	raw, err := json.Marshal(e.Payload)
	if err != nil {
		return 0, err
	}
	if e.Payload == nil {
		raw = []byte("{}")
	}
	return db.New(d).AppendEvent(ctx, db.AppendEventParams{
		Type: e.Type, ActorID: nullInt(e.Actor), SessionID: nullInt(e.Session), ConversationID: nullInt(e.Conversation),
		AudienceID: nullInt(e.Audience), MessageID: nullInt(e.Message), PayloadJson: string(raw),
		IdemKey:   sql.NullString{String: e.IdemKey, Valid: e.IdemKey != ""},
		CreatedAt: now.UnixMilli(),
	})
}

// Append writes an event that has no actor, conversation or message: the account and machine events of S1.
func Append(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload any) (int64, error) {
	if id, played, err := appendAsPreviousRelease(ctx, d, now, typ, payload); played {
		return id, err
	}
	return Write(ctx, d, now, Entry{Type: typ, Payload: payload})
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

// Idem is the event a retry-safe command wrote earlier.
type Idem struct {
	Conversation int64
	Payload      string // the JSON the command wrote
}

// FindIdem returns the event written for (actor, key); ok is false when there is none.
func FindIdem(ctx context.Context, d pdb.DBTX, actor int64, key string) (e Idem, ok bool, err error) {
	r, err := db.New(d).EventByIdem(ctx, db.EventByIdemParams{ActorID: nullInt(actor), IdemKey: sql.NullString{String: key, Valid: true}})
	if errors.Is(err, sql.ErrNoRows) {
		return Idem{}, false, nil
	}
	return Idem{Conversation: r.ConversationID.Int64, Payload: r.PayloadJson}, err == nil, err
}
