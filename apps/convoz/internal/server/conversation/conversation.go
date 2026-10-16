// Package conversation owns the conversations and participants tables: who talks where, and in what order the list
// shows. It never reads a message; the composition root hands it what it needs to record a post.
package conversation

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits (design §13.1, §7 CHECKs).
const (
	MaxTitleRunes   = 120
	AutoTitleRunes  = 60
	MaxParticipants = 20
	MaxListed       = 200
)

// Conversation is one row of the list or the header of a chat. Ids and times are as stored (milliseconds).
type Conversation struct {
	ID             int64
	Title          string // empty when the conversation has none yet
	CreatedBy      int64
	CreatedAt      int64
	LastMessageID  int64
	LastMainID     int64
	LastActivityAt int64
	MessageCount   int64
}

// Participant is an active member and the first message it may see (0 = all history).
type Participant struct {
	IdentityID      int64
	JoinedMessageID int64
}

// Member is one identity's standing in one conversation.
type Member struct {
	Active          bool
	JoinedMessageID int64
}

// New says who starts a conversation and with whom. By is a participant too; Members are active at once
// (a human adds an agent without a request, design §2.3).
type New struct {
	By      int64
	Title   string // a title the creator chose; empty for an automatic one
	Members []int64
}

// ValidTitle reports whether s can be a chosen title (1 to 120 runes, no control characters).
func ValidTitle(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 1 && n <= MaxTitleRunes && !strings.ContainsFunc(s, unicode.IsControl)
}

// AutoTitle is the first 60 runes of body on one line; empty when body has no visible text.
func AutoTitle(body string) string {
	line := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(line) > AutoTitleRunes {
		line = string([]rune(line)[:AutoTitleRunes])
	}
	return line
}

func fromRow(id int64, title sql.NullString, by, createdAt, lastMsg, lastMain, lastActivity, count int64) Conversation {
	return Conversation{ID: id, Title: title.String, CreatedBy: by, CreatedAt: createdAt, LastMessageID: lastMsg, LastMainID: lastMain, LastActivityAt: lastActivity, MessageCount: count}
}

// Create writes the conversation and its participants inside the caller's transaction.
func Create(ctx context.Context, d pdb.DBTX, now time.Time, in New) (Conversation, error) {
	q := db.New(d)
	at := now.UnixMilli()
	source := "auto"
	if in.Title != "" {
		source = "manual"
	}
	id, err := q.InsertConversation(ctx, db.InsertConversationParams{
		Title: sql.NullString{String: in.Title, Valid: in.Title != ""}, TitleSource: source, CreatedBy: in.By, CreatedAt: at,
	})
	if err != nil {
		return Conversation{}, err
	}
	seen := map[int64]bool{}
	for _, who := range append([]int64{in.By}, in.Members...) {
		if seen[who] {
			continue
		}
		seen[who] = true
		if err := q.InsertParticipant(ctx, db.InsertParticipantParams{ConversationID: id, IdentityID: who, AddedBy: in.By, At: at}); err != nil {
			return Conversation{}, err
		}
	}
	return Conversation{ID: id, Title: in.Title, CreatedBy: in.By, CreatedAt: at, LastActivityAt: at}, nil
}

// Get returns one conversation that is not deleted; ok is false when there is none.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Conversation, bool, error) {
	r, err := db.New(d).GetConversation(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	return fromRow(r.ID, r.Title, r.CreatedBy, r.CreatedAt, r.LastMessageID, r.LastMainID, r.LastActivityAt, r.MessageCount), err == nil, err
}

// ListAll returns every conversation, latest activity first (the owner sees all).
func ListAll(ctx context.Context, d pdb.DBTX) ([]Conversation, error) {
	rows, err := db.New(d).ListAllConversations(ctx, MaxListed)
	if err != nil {
		return nil, err
	}
	out := make([]Conversation, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.Title, r.CreatedBy, r.CreatedAt, r.LastMessageID, r.LastMainID, r.LastActivityAt, r.MessageCount))
	}
	return out, nil
}

// ListOf returns the conversations the identity is an active participant of, latest activity first.
func ListOf(ctx context.Context, d pdb.DBTX, identityID int64) ([]Conversation, error) {
	rows, err := db.New(d).ListConversationsOfIdentity(ctx, db.ListConversationsOfIdentityParams{IdentityID: identityID, MaxRows: MaxListed})
	if err != nil {
		return nil, err
	}
	out := make([]Conversation, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.Title, r.CreatedBy, r.CreatedAt, r.LastMessageID, r.LastMainID, r.LastActivityAt, r.MessageCount))
	}
	return out, nil
}

// Participants lists the active participants, oldest first.
func Participants(ctx context.Context, d pdb.DBTX, id int64) ([]Participant, error) {
	rows, err := db.New(d).ListActiveParticipants(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]Participant, 0, len(rows))
	for _, r := range rows {
		out = append(out, Participant{IdentityID: r.IdentityID, JoinedMessageID: r.JoinedMessageID})
	}
	return out, nil
}

// Membership is the identity's standing in the conversation; found is false when it never was a participant.
func Membership(ctx context.Context, d pdb.DBTX, id, identityID int64) (m Member, found bool, err error) {
	r, err := db.New(d).GetParticipant(ctx, db.GetParticipantParams{ConversationID: id, IdentityID: identityID})
	if errors.Is(err, sql.ErrNoRows) {
		return Member{}, false, nil
	}
	return Member{Active: r.Status == "active", JoinedMessageID: r.JoinedMessageID}, err == nil, err
}

// RecordMainPost moves the conversation's counters for a new main-thread message and names a nameless
// conversation after it. It returns last_main_id from before the post, which the author's read-cursor rule needs.
func RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, id, messageID int64, body string) (prevLastMain int64, err error) {
	c, ok, err := Get(ctx, d, id)
	if err != nil || !ok {
		return 0, errors.Join(err, errors.New("conversation not found"))
	}
	q := db.New(d)
	if err := q.RecordMainPost(ctx, db.RecordMainPostParams{MessageID: messageID, At: now.UnixMilli(), ID: id}); err != nil {
		return 0, err
	}
	if title := AutoTitle(body); title != "" && c.Title == "" {
		if err := q.SetAutoTitle(ctx, db.SetAutoTitleParams{Title: sql.NullString{String: title, Valid: true}, ID: id}); err != nil {
			return 0, err
		}
	}
	return c.LastMainID, nil
}
