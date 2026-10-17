// Package message owns the messages table: writing a text message once per client id, editing, deleting and purging it,
// system lines, mentions, the loop breaker's rule and the plain-text projection, and reading pages of them.
// It knows nothing of who may see a conversation; the caller passes the first visible id (the floor) to every read.
package message

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits (design §13.1).
const (
	MaxBodyBytes = 16384
	MaxAppBytes  = 65536
	MaxUploads   = 10
	MaxURLs      = 5
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
	ErrAppTooLarge      = errors.New("the app is over 65536 bytes")
	ErrTooManyUploads   = errors.New("a message carries at most 10 attachments")
	ErrTooManyURLs      = errors.New("a message has at most 5 links")
	ErrBadRoot          = errors.New("a reply goes under a top-level message of the same conversation")
	ErrSystemRoot       = errors.New("a system line cannot have replies")
)

// Message is a stored message as a reader sees it: a deleted one has an empty Body and Deleted set.
type Message struct {
	ID             int64
	ConversationID int64
	AuthorID       int64 // 0 for a system line
	Kind           string
	Format         string
	Body           string
	CreatedAt      int64
	ThreadRootID   int64 // 0 for a message of the main list
	Broadcast      bool
	ReplyCount     int64
	LastReplyAt    int64 // when the newest reply came, 0 for none
	EditedAt       int64 // 0 for never
	Deleted        bool
	Purged         bool
	System         string // a system line's system_json: ids only
	SessionID      int64
	AnswersAskID   int64
	ViaAppID       int64 // the app message a result came through
	HasApp         bool
	OriginLabel    string // the agent session that wrote it, and its machine (I-40)
	OriginMachine  string
}

// Origin says where an agent's message came from.
type Origin struct{ Label, Machine string }

// Draft is a message to write. Session and Device say where it came from; zero means none.
type Draft struct {
	Conversation int64
	Author       int64
	Session      int64
	Device       int64
	Origin       Origin
	ClientID     string
	Body         string
	Format       string   // empty means markdown
	Kind         string   // "ask" for the message of an ask; empty is a text message
	AnswersAsk   int64    // the ask this message answers (the ask module writes it); 0 for none
	ThreadRoot   int64    // the top-level message this replies to; 0 for a main message
	Broadcast    bool     // a reply also shown in the main list
	App          []byte   // an app message's app.v1 JSON (appkit); nil for none
	UploadIDs    []string // public ids of the uploads the message carries; nil for none
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

func nullStr(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

func fromRow(r db.MessageRow) Message {
	return Message{
		ID: r.ID, ConversationID: r.ConversationID, AuthorID: r.AuthorID.Int64, Kind: r.Kind, Format: r.Format, Body: r.Body, CreatedAt: r.CreatedAt,
		ThreadRootID: r.ThreadRootID.Int64, Broadcast: r.Broadcast == 1, ReplyCount: r.ReplyCount, LastReplyAt: r.LastReplyAt.Int64, EditedAt: r.EditedAt.Int64,
		Deleted: r.DeletedAt.Valid, Purged: r.PurgedAt.Valid, System: r.SystemJson.String, SessionID: r.SessionID.Int64,
		AnswersAskID: r.AnswersAskID.Int64, ViaAppID: r.ViaAppMessageID.Int64, HasApp: r.HasApp == 1,
		OriginLabel: r.OriginLabel.String, OriginMachine: r.OriginMachine.String,
	}
}

func fromRows(rows []db.MessageRow, reverse bool) []Message {
	out := make([]Message, len(rows))
	for i, r := range rows {
		if reverse {
			out[len(rows)-1-i] = fromRow(r)
		} else {
			out[i] = fromRow(r)
		}
	}
	return out
}

var urlRE = regexp.MustCompile(`(?i)\bhttps?://[^\s<>]`)

// checkText validates a body and format. It is the same check for a new message and an edit.
func checkText(body, format string) error {
	switch {
	case format != "markdown" && format != "markdownv2" && format != "plain":
		return ErrFormat
	case len(body) > MaxBodyBytes:
		return ErrTooLarge
	case strings.TrimSpace(body) == "":
		return ErrEmpty
	case strings.ContainsRune(body, 0):
		return ErrNUL
	case len(urlRE.FindAllStringIndex(body, MaxURLs+1)) > MaxURLs:
		return ErrTooManyURLs
	}
	return nil
}

// checkFiles is checkText for a message whose words may be empty: the format and the NUL rule still hold.
func checkFiles(body, format string) error {
	switch {
	case format != "markdown" && format != "markdownv2" && format != "plain":
		return ErrFormat
	case strings.ContainsRune(body, 0):
		return ErrNUL
	}
	return nil
}

func checkDraft(d Draft) error {
	switch {
	case len(d.App) > MaxAppBytes:
		return ErrAppTooLarge
	case len(d.UploadIDs) > MaxUploads:
		return ErrTooManyUploads
	case len(d.UploadIDs) > 0 && strings.TrimSpace(d.Body) == "":
		return checkFiles(d.Body, d.Format) // a message of files alone (a voice note, a picture) needs no words
	}
	return checkText(d.Body, d.Format)
}

// insert writes d once per (author, client id), inside the caller's transaction. A repeat of the same message returns
// the stored one with replayed true and changes nothing; the same client id with another body, format or
// conversation is ErrClientIDConflict (I-24).
func insert(ctx context.Context, tx pdb.DBTX, now time.Time, d Draft) (m Message, replayed bool, err error) {
	if d.Format == "" {
		d.Format = "markdown"
	}
	if err := checkDraft(d); err != nil {
		return Message{}, false, err
	}
	q := db.New(tx)
	prev, err := q.GetIDByClient(ctx, db.GetIDByClientParams{AuthorID: nullInt(d.Author), ClientID: sql.NullString{String: d.ClientID, Valid: true}})
	if err == nil {
		m, _, err := get(ctx, tx, prev)
		if err != nil {
			return Message{}, false, err
		}
		if m.ConversationID != d.Conversation || m.Body != d.Body || m.Format != d.Format {
			return Message{}, false, ErrClientIDConflict
		}
		return m, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, err
	}
	at := now.UnixMilli()
	kind := d.Kind
	if kind == "" {
		kind = "text"
	}
	p := db.InsertMessageParams{
		ConversationID: d.Conversation, AuthorID: nullInt(d.Author), Kind: kind, Format: d.Format, Body: d.Body, AnswersAskID: nullInt(d.AnswersAsk),
		ThreadRootID: nullInt(d.ThreadRoot), Broadcast: boolInt(d.Broadcast),
		SessionID: nullInt(d.Session), DeviceID: nullInt(d.Device), ClientID: sql.NullString{String: d.ClientID, Valid: true},
		OriginLabel: nullStr(d.Origin.Label), OriginMachine: nullStr(d.Origin.Machine), CreatedAt: at,
	}
	if len(d.App) > 0 {
		p.AppJson = sql.NullString{String: string(d.App), Valid: true}
	}
	id, err := q.InsertMessage(ctx, p)
	if err != nil {
		return Message{}, false, err
	}
	return Message{
		ID: id, ConversationID: d.Conversation, AuthorID: d.Author, Kind: kind, Format: d.Format, Body: d.Body, CreatedAt: at, AnswersAskID: d.AnswersAsk,
		ThreadRootID: d.ThreadRoot, Broadcast: d.Broadcast, SessionID: d.Session, HasApp: len(d.App) > 0,
		OriginLabel: d.Origin.Label, OriginMachine: d.Origin.Machine,
	}, false, nil
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func get(ctx context.Context, d pdb.DBTX, id int64) (Message, bool, error) {
	r, err := db.New(d).GetMessage(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	return fromRow(r), err == nil, err
}

// Get returns one message that is not deleted; ok is false when there is none.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Message, bool, error) {
	m, ok, err := get(ctx, d, id)
	return m, ok && !m.Deleted, err
}

// GetAny returns one message, a deleted one as a tombstone (empty body, Deleted set); ok is false when there is none.
func GetAny(ctx context.Context, d pdb.DBTX, id int64) (Message, bool, error) { return get(ctx, d, id) }

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

// Newest returns the newest limit main-list messages above floor, oldest first. A deleted one is a tombstone.
func Newest(ctx context.Context, d pdb.DBTX, conv, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageNewest(ctx, db.PageNewestParams{ConversationID: conv, Floor: floor, MaxRows: int64(ClampLimit(limit))})
	return fromRows(rows, true), err
}

// Before returns the newest limit main-list messages with id < before and above floor, oldest first.
func Before(ctx context.Context, d pdb.DBTX, conv, before, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageBefore(ctx, db.PageBeforeParams{ConversationID: conv, Before: before, Floor: floor, MaxRows: int64(ClampLimit(limit))})
	return fromRows(rows, true), err
}

// After returns the oldest limit main-list messages with id > after (and above floor), oldest first.
func After(ctx context.Context, d pdb.DBTX, conv, after, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).PageAfter(ctx, db.PageAfterParams{ConversationID: conv, After: max(after, floor), MaxRows: int64(ClampLimit(limit))})
	return fromRows(rows, false), err
}

// CountUnread counts main messages after the read position that someone else wrote, stopping at MaxUnread.
// The caller passes max(cursor, floor) as after. System lines and deleted messages never count (I-14).
func CountUnread(ctx context.Context, d pdb.DBTX, conv, after, reader int64) (int64, error) {
	return db.New(d).CountUnread(ctx, db.CountUnreadParams{ConversationID: conv, After: after, ReaderID: nullInt(reader), MaxRows: MaxUnread})
}

// Mentioned lists the identity ids a message mentions.
func Mentioned(ctx context.Context, d pdb.DBTX, id int64) ([]int64, error) {
	return db.New(d).ListMentions(ctx, id)
}

// StoreMentions records that message id mentions each identity.
func StoreMentions(ctx context.Context, d pdb.DBTX, id int64, identities []int64) error {
	q := db.New(d)
	for _, who := range identities {
		if err := q.InsertMention(ctx, db.InsertMentionParams{MessageID: id, IdentityID: who}); err != nil {
			return err
		}
	}
	return nil
}
