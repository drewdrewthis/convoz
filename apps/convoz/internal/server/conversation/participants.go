package conversation

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Standings of a participant (design §7).
const (
	StatusPending  = "pending"
	StatusActive   = "active"
	StatusLeft     = "left"
	StatusRemoved  = "removed"
	StatusDeclined = "declined"
)

// ErrFull means the conversation already holds 20 active or pending participants.
var ErrFull = errors.New("a conversation has at most 20 participants")

// Seat is one participant row with its history.
type Seat struct {
	IdentityID      int64
	Status          string
	JoinedMessageID int64
	JoinedSeq       int64
	AddedBy         int64
	RequestedBy     int64 // the agent that asked for the add; 0 when a human added it
	StatusAt        int64
}

func seatOf(r db.Participant) Seat {
	return Seat{
		IdentityID: r.IdentityID, Status: r.Status, JoinedMessageID: r.JoinedMessageID, JoinedSeq: r.JoinedSeq,
		AddedBy: r.AddedBy, RequestedBy: r.RequestedBy.Int64, StatusAt: r.StatusAt,
	}
}

// SeatOf returns one identity's row; found is false when it never was a participant.
func SeatOf(ctx context.Context, d pdb.DBTX, conv, identityID int64) (s Seat, found bool, err error) {
	r, err := db.New(d).GetParticipantFull(ctx, db.GetParticipantFullParams{ConversationID: conv, IdentityID: identityID})
	if errors.Is(err, sql.ErrNoRows) {
		return Seat{}, false, nil
	}
	return seatOf(r), err == nil, err
}

// Pending lists the participants waiting for a human, oldest first.
func Pending(ctx context.Context, d pdb.DBTX, conv int64) ([]Seat, error) {
	rows, err := db.New(d).ListParticipantsByStatus(ctx, db.ListParticipantsByStatusParams{ConversationID: conv, Status: StatusPending})
	if err != nil {
		return nil, err
	}
	out := make([]Seat, 0, len(rows))
	for _, r := range rows {
		out = append(out, seatOf(r))
	}
	return out, nil
}

// PendingAdd is a waiting add and the conversation it is for.
type PendingAdd struct {
	Conversation, IdentityID, RequestedBy, At int64
}

// AllPending lists every waiting add of every live conversation, oldest first (what Now shows).
func AllPending(ctx context.Context, d pdb.DBTX) ([]PendingAdd, error) {
	rows, err := db.New(d).ListPendingOfConversations(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PendingAdd, 0, len(rows))
	for _, r := range rows {
		out = append(out, PendingAdd{Conversation: r.ConversationID, IdentityID: r.IdentityID, RequestedBy: r.RequestedBy.Int64, At: r.StatusAt})
	}
	return out, nil
}

// Join says how a person comes into a conversation. A member always sees the whole history of it (owner, msg 143), so there is
// no message floor; Seq is the event floor (I-7). RequestedBy is the agent that asked, for a pending add.
type Join struct {
	Conversation, Identity, By int64
	Status                     string // StatusActive or StatusPending
	Seq                        int64
	RequestedBy                int64
}

// Add seats a person. A person who is active already is left as is (changed false); one who left, was removed or was
// declined comes back, and one who is pending is activated by a human add.
func Add(ctx context.Context, d pdb.DBTX, now time.Time, j Join) (changed bool, err error) {
	q := db.New(d)
	at := now.UnixMilli()
	cur, found, err := SeatOf(ctx, d, j.Conversation, j.Identity)
	if err != nil {
		return false, err
	}
	if found && cur.Status == StatusActive {
		return false, nil
	}
	if found && cur.Status == StatusPending && j.Status == StatusPending {
		return false, nil
	}
	if !found || cur.Status != StatusPending {
		n, err := q.CountLiveParticipants(ctx, j.Conversation)
		if err != nil {
			return false, err
		}
		if n >= MaxParticipants {
			return false, ErrFull
		}
	}
	requested := sql.NullInt64{Int64: j.RequestedBy, Valid: j.RequestedBy != 0}
	if !found {
		return true, q.InsertParticipant(ctx, db.InsertParticipantParams{
			ConversationID: j.Conversation, IdentityID: j.Identity, Status: j.Status, JoinedSeq: j.Seq,
			AddedBy: j.By, RequestedBy: requested, At: at,
		})
	}
	return true, q.ReviveParticipant(ctx, db.ReviveParticipantParams{
		Status: j.Status, JoinedSeq: j.Seq, AddedBy: j.By, RequestedBy: requested, At: at,
		ConversationID: j.Conversation, IdentityID: j.Identity,
	})
}

// Decide approves or declines a pending add. It reports false when there was none.
func Decide(ctx context.Context, d pdb.DBTX, now time.Time, conv, identityID, human int64, approve bool) (bool, error) {
	status := StatusDeclined
	if approve {
		status = StatusActive
	}
	n, err := db.New(d).DecideParticipant(ctx, db.DecideParticipantParams{
		Status: status, DecidedBy: sql.NullInt64{Int64: human, Valid: true}, At: now.UnixMilli(),
		ConversationID: conv, IdentityID: identityID,
	})
	return n > 0, err
}

// End takes an active participant out: StatusRemoved when a human did it, StatusLeft when the person left. It
// reports false when the person was not active.
func End(ctx context.Context, d pdb.DBTX, now time.Time, conv, identityID int64, status string) (bool, error) {
	n, err := db.New(d).EndParticipant(ctx, db.EndParticipantParams{Status: status, At: now.UnixMilli(), ConversationID: conv, IdentityID: identityID})
	return n > 0, err
}

// NoteAgentPost records which session of the agent posted last in the conversation: its inbox items for that conversation
// go to that session first (design §3.8).
func NoteAgentPost(ctx context.Context, d pdb.DBTX, conv, identityID, sessionID int64) error {
	return db.New(d).SetLastPostSession(ctx, db.SetLastPostSessionParams{
		SessionID: sql.NullInt64{Int64: sessionID, Valid: sessionID != 0}, ConversationID: conv, IdentityID: identityID,
	})
}

// LastPostSession is the session of the agent that posted last in the conversation; 0 when none did or it was not a session.
func LastPostSession(ctx context.Context, d pdb.DBTX, conv, identityID int64) (int64, error) {
	r, err := db.New(d).GetParticipantFull(ctx, db.GetParticipantFullParams{ConversationID: conv, IdentityID: identityID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return r.LastPostSessionID.Int64, err
}
