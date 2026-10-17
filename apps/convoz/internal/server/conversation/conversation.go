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

// Conversation is one row of the list or the header of a chat. Ids and times are as stored (milliseconds); 0 means
// "not set" for the optional ones.
type Conversation struct {
	ID             int64
	Title          string // empty when the conversation has none yet
	TitleManual    bool   // the owner chose the title; a message never renames it
	CreatedBy      int64
	CreatedAt      int64
	LinkURL        string
	LastMessageID  int64
	LastMainID     int64
	LastActivityAt int64
	MessageCount   int64
	AgentStreak    int64
	PausedAt       int64
	PickupOpenedAt int64
	PickupOpenedBy int64
	AssignVersion  int64
	DeletedAt      int64
	DeletedBy      int64
}

// Paused reports whether the loop breaker has stopped the agents (I-16).
func (c Conversation) Paused() bool { return c.PausedAt != 0 }

// Participant is an active member and the first message it may see (0 = all history).
type Participant struct {
	IdentityID      int64
	JoinedMessageID int64
}

// Member is one identity's standing in one conversation. Status is the stored one: pending, active, left, removed or declined.
type Member struct {
	Active          bool
	Status          string
	JoinedMessageID int64
}

// New says who starts a conversation and with whom. By is a participant too; Members are active at once
// (a human adds an agent without a request, design §2.3). Pending are the people an agent listed: they wait for a
// human to approve them and see nothing until then (I-17).
type New struct {
	By      int64
	Title   string // a title the creator chose; empty for an automatic one
	Members []int64
	Pending []int64
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

func fromRow(r db.Conversation) Conversation {
	return Conversation{
		ID: r.ID, Title: r.Title.String, TitleManual: r.TitleSource == "manual", CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt, LinkURL: r.LinkUrl.String,
		LastMessageID: r.LastMessageID, LastMainID: r.LastMainID, LastActivityAt: r.LastActivityAt, MessageCount: r.MessageCount,
		AgentStreak: r.AgentStreak, PausedAt: r.PausedAt.Int64, PickupOpenedAt: r.PickupOpenedAt.Int64, PickupOpenedBy: r.PickupOpenedBy.Int64,
		AssignVersion: r.AssignVersion, DeletedAt: r.DeletedAt.Int64, DeletedBy: r.DeletedBy.Int64,
	}
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
		if err := q.InsertParticipant(ctx, db.InsertParticipantParams{ConversationID: id, IdentityID: who, Status: "active", AddedBy: in.By, At: at}); err != nil {
			return Conversation{}, err
		}
	}
	for _, who := range in.Pending {
		if seen[who] {
			continue
		}
		seen[who] = true
		err := q.InsertParticipant(ctx, db.InsertParticipantParams{
			ConversationID: id, IdentityID: who, Status: "pending", AddedBy: in.By, RequestedBy: sql.NullInt64{Int64: in.By, Valid: true}, At: at,
		})
		if err != nil {
			return Conversation{}, err
		}
	}
	return Conversation{ID: id, Title: in.Title, TitleManual: in.Title != "", CreatedBy: in.By, CreatedAt: at, LastActivityAt: at}, nil
}

// Get returns one conversation that is not deleted; ok is false when there is none.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Conversation, bool, error) {
	r, err := db.New(d).GetConversation(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	return fromRow(r), err == nil, err
}

// GetAny is Get for a conversation in the trash too.
func GetAny(ctx context.Context, d pdb.DBTX, id int64) (Conversation, bool, error) {
	r, err := db.New(d).GetConversationAny(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	return fromRow(r), err == nil, err
}

func fromRows(rows []db.Conversation) []Conversation {
	out := make([]Conversation, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r))
	}
	return out
}

// ListAll returns every conversation, latest activity first (the owner sees all).
func ListAll(ctx context.Context, d pdb.DBTX) ([]Conversation, error) {
	rows, err := db.New(d).ListAllConversations(ctx, MaxListed)
	return fromRows(rows), err
}

// ListOf returns the conversations the identity is an active participant of, latest activity first.
func ListOf(ctx context.Context, d pdb.DBTX, identityID int64) ([]Conversation, error) {
	rows, err := db.New(d).ListConversationsOfIdentity(ctx, db.ListConversationsOfIdentityParams{IdentityID: identityID, MaxRows: MaxListed})
	return fromRows(rows), err
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
	return Member{Active: r.Status == "active", Status: r.Status, JoinedMessageID: r.JoinedMessageID}, err == nil, err
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

// Touch moves the conversation up the list without counting a message (a system line).
func Touch(ctx context.Context, d pdb.DBTX, now time.Time, id int64) error {
	return db.New(d).TouchActivity(ctx, db.TouchActivityParams{At: now.UnixMilli(), ID: id})
}

// Rename sets a title the owner chose. Later messages never change it (the source is "manual").
func Rename(ctx context.Context, d pdb.DBTX, id int64, title string) error {
	return db.New(d).SetTitle(ctx, db.SetTitleParams{Title: sql.NullString{String: title, Valid: true}, ID: id})
}

// SetLink sets or (with "") clears the pull request link the details show.
func SetLink(ctx context.Context, d pdb.DBTX, id int64, url string) error {
	return db.New(d).SetLink(ctx, db.SetLinkParams{LinkUrl: sql.NullString{String: url, Valid: url != ""}, ID: id})
}

// ValidLink reports whether s can be the pull request link: https, at most 500 characters, no control characters or spaces.
func ValidLink(s string) bool {
	return len(s) <= 500 && strings.HasPrefix(s, "https://") && len(s) > len("https://") && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}
