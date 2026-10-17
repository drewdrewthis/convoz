// Package message owns the messages table: writing a text message once per client id, and reading pages of them.
// It knows nothing of who may see a conversation; the caller passes the first visible id (the floor) to every read.
package message

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits (design §13.1).
const (
	MaxBodyBytes = 16384
	MaxPage      = 100
	DefaultPage  = 50
	// MaxUnread is where the unread count stops ("99+" in the UI shows at 100).
	MaxUnread = 100
)

// Errors Post returns; the HTTP layer names the field of each.
var (
	ErrEmpty            = errors.New("the message is empty")
	ErrTooLarge         = errors.New("the message body is over 16384 bytes")
	ErrFormat           = errors.New("format is markdown, markdownv2 or plain")
	ErrNUL              = errors.New("the message has a NUL character")
	ErrClientIDConflict = errors.New("that client id was used for a different message")
)

// Message is a stored text message.
type Message struct {
	ID             int64
	ConversationID int64
	AuthorID       int64
	Kind           string
	Format         string
	Body           string
	CreatedAt      int64
}

// Draft is a message to write. Session and Device say where it came from; zero means none.
type Draft struct {
	Conversation int64
	Author       int64
	Session      int64
	Device       int64
	ClientID     string
	Body         string
	Format       string   // empty means markdown
	App          []byte   // an app message's app.v1 JSON (appkit); nil for none
	UploadIDs    []string // public ids of the uploads the message carries; nil for none
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

func nullString(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }

// insert writes d once per (author, client id), inside the caller's transaction. A repeat of the same message returns
// the stored one with replayed true and changes nothing; the same client id with another body, format or
// conversation is ErrClientIDConflict (I-24).
func insert(ctx context.Context, tx pdb.DBTX, now time.Time, d Draft) (m Message, replayed bool, err error) {
	if d.Format == "" {
		d.Format = "markdown"
	}
	switch {
	case d.Format != "markdown" && d.Format != "markdownv2" && d.Format != "plain":
		return Message{}, false, ErrFormat
	case len(d.Body) > MaxBodyBytes:
		return Message{}, false, ErrTooLarge
	case strings.TrimSpace(d.Body) == "":
		return Message{}, false, ErrEmpty
	case strings.ContainsRune(d.Body, 0):
		return Message{}, false, ErrNUL
	}
	q := db.New(tx)
	prev, err := q.GetMessageByClient(ctx, db.GetMessageByClientParams{AuthorID: nullInt(d.Author), ClientID: sql.NullString{String: d.ClientID, Valid: true}})
	if err == nil {
		m := fromRow(prev.ID, prev.ConversationID, prev.AuthorID, prev.Kind, prev.Format, prev.Body, prev.CreatedAt)
		if m.ConversationID != d.Conversation || m.Body != d.Body || m.Format != d.Format {
			return Message{}, false, ErrClientIDConflict
		}
		return m, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, err
	}
	at := now.UnixMilli()
	id, err := q.InsertMessage(ctx, db.InsertMessageParams{
		ConversationID: d.Conversation, AuthorID: nullInt(d.Author), Format: d.Format, Body: d.Body,
		SessionID: nullInt(d.Session), DeviceID: nullInt(d.Device), ClientID: sql.NullString{String: d.ClientID, Valid: true}, CreatedAt: at,
	})
	if err != nil {
		return Message{}, false, err
	}
	return Message{ID: id, ConversationID: d.Conversation, AuthorID: d.Author, Kind: "text", Format: d.Format, Body: d.Body, CreatedAt: at}, false, nil
}

func fromRow(id, conv int64, author sql.NullInt64, kind, format, body string, createdAt int64) Message {
	return Message{ID: id, ConversationID: conv, AuthorID: author.Int64, Kind: kind, Format: format, Body: body, CreatedAt: createdAt}
}

// Get returns one message that is not deleted; ok is false when there is none.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Message, bool, error) {
	r, err := db.New(d).GetMessage(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	return fromRow(r.ID, r.ConversationID, r.AuthorID, r.Kind, r.Format, r.Body, r.CreatedAt), err == nil, err
}

// ClampLimit turns a requested page size into one in 1..MaxPage (DefaultPage when it is 0).
func ClampLimit(n int) int {
	switch {
	case n <= 0:
		return DefaultPage
	case n > MaxPage:
		return MaxPage
	}
	return n
}

// Newest returns the newest limit main messages above floor, oldest first.
func Newest(ctx context.Context, d pdb.DBTX, conv, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageNewest(ctx, db.PageNewestParams{ConversationID: conv, Floor: floor, MaxRows: int64(ClampLimit(limit))})
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		out = append(out, fromRow(r.ID, r.ConversationID, r.AuthorID, r.Kind, r.Format, r.Body, r.CreatedAt))
	}
	return out, nil
}

// Before returns the newest limit main messages with id < before and above floor, oldest first.
func Before(ctx context.Context, d pdb.DBTX, conv, before, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageBefore(ctx, db.PageBeforeParams{ConversationID: conv, Before: before, Floor: floor, MaxRows: int64(ClampLimit(limit))})
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		out = append(out, fromRow(r.ID, r.ConversationID, r.AuthorID, r.Kind, r.Format, r.Body, r.CreatedAt))
	}
	return out, nil
}

// After returns the oldest limit main messages with id > after (and above floor), oldest first.
func After(ctx context.Context, d pdb.DBTX, conv, after, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageAfter(ctx, db.PageAfterParams{ConversationID: conv, After: max(after, floor), MaxRows: int64(ClampLimit(limit))})
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.ConversationID, r.AuthorID, r.Kind, r.Format, r.Body, r.CreatedAt))
	}
	return out, nil
}

// CountUnread counts main messages after the read position that someone else wrote, stopping at MaxUnread.
// The caller passes max(cursor, floor) as after.
func CountUnread(ctx context.Context, d pdb.DBTX, conv, after, reader int64) (int64, error) {
	return db.New(d).CountUnread(ctx, db.CountUnreadParams{ConversationID: conv, After: after, ReaderID: nullInt(reader), MaxRows: MaxUnread})
}
