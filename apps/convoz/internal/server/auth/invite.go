package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Agent invites (owner ruling, 2026-10-18): "if something requests access, there's never really a way to know without access to that
// agents internal session. What we could do I require a token to request access that always changes, but I want agents to be able to
// invite other agents. So I guess invites are always 1 time use?"
//
// A request that comes in over the internet must carry an invite. The invite is spent when the request is made; a request the owner
// declines does not give it back. Only the SHA-256 of the token is kept.
const (
	// InviteTTL is how long an invite works if nobody uses it.
	InviteTTL = 24 * time.Hour
	// MaxOpenInvites is how many unused, unexpired invites one maker may hold.
	MaxOpenInvites = 10
)

// The kinds of request an invite is spent on.
const (
	InviteLogin   = "login"   // POST /api/device/code: a machine and, maybe, its agent
	InviteSession = "session" // POST /api/sessions with create: an agent on a machine that is logged in
)

// Refusals of the invite flows; the HTTP layer maps each to an answer.
var (
	ErrInviteCap         = errors.New("too many open invites")
	ErrNoInvite          = errors.New("no such open invite")
	ErrNotInConversation = errors.New("the maker is not in that conversation")
)

// Invite is an open invite as a list shows it. The token is not kept, so no list can show it.
type Invite struct {
	ID             int64
	Hint           string // the last 4 characters of the token
	MakerID        int64
	ConversationID int64 // 0: none
	Note           string
	CreatedAt      int64
	ExpiresAt      int64
}

// InviteMark says who invited the agent behind a waiting request, for the owner's card.
type InviteMark struct {
	MakerID int64
	Note    string
}

// NewInvite is what a maker asks for. By carries who is asking, for the audit line.
type NewInvite struct {
	By             AuditEntry
	ConversationID int64
	Note           string
}

func inviteOf(id int64, hint string, maker int64, conv sql.NullInt64, note string, created, expires int64) Invite {
	return Invite{ID: id, Hint: hint, MakerID: maker, ConversationID: conv.Int64, Note: note, CreatedAt: created, ExpiresAt: expires}
}

// CreateInvite makes an invite for the maker in in.By.Actor and returns it with its token, which is shown once. An agent may invite
// only into a conversation it is in; the owner likewise. Run it in a write transaction.
func CreateInvite(ctx context.Context, d pdb.DBTX, p Ports, in NewInvite, now time.Time) (Invite, string, error) {
	q := db.New(d)
	if !ValidIntro(in.Note) {
		return Invite{}, "", &FieldError{Field: "note", Message: "A note is one line of plain text, up to 80 characters."}
	}
	if in.ConversationID != 0 {
		if member, err := p.Conversations.IdentityIn(ctx, d, in.ConversationID, in.By.Actor); err != nil {
			return Invite{}, "", err
		} else if !member {
			return Invite{}, "", ErrNotInConversation
		}
	}
	open, err := q.CountOpenInvitesOfMaker(ctx, db.CountOpenInvitesOfMakerParams{MakerID: in.By.Actor, Now: now.UnixMilli()})
	if err != nil {
		return Invite{}, "", err
	}
	if open >= MaxOpenInvites {
		return Invite{}, "", ErrInviteCap
	}
	token := newToken(PrefixInvite)
	arg := db.InsertInviteParams{
		TokenHash: hashToken(token), Hint: token[len(token)-4:], MakerID: in.By.Actor, ConversationID: nullInt(in.ConversationID),
		Note: in.Note, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(InviteTTL).UnixMilli(),
	}
	id, err := q.InsertInvite(ctx, arg)
	if err != nil {
		return Invite{}, "", err
	}
	detail := map[string]any{}
	if in.ConversationID != 0 {
		detail["conversation_id"] = in.ConversationID
	}
	if err := auditInvite(ctx, d, p, now, in.By, "invite.created", id, detail); err != nil {
		return Invite{}, "", err
	}
	return inviteOf(id, arg.Hint, arg.MakerID, arg.ConversationID, arg.Note, arg.CreatedAt, arg.ExpiresAt), token, nil
}

func auditInvite(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, by AuditEntry, action string, id int64, detail map[string]any) error {
	by.Action, by.TargetKind, by.TargetID, by.Detail = action, "invite", id, detail
	return p.Journal.Audit(ctx, d, now, by)
}

// OpenInvites lists the invites that can still be used, newest first: every maker's when maker is 0, else that maker's.
func OpenInvites(ctx context.Context, d pdb.DBTX, maker int64, now time.Time) ([]Invite, error) {
	if beforeInvites() {
		return nil, nil
	}
	rows, err := db.New(d).ListOpenInvites(ctx, db.ListOpenInvitesParams{MakerID: maker, Now: now.UnixMilli()})
	out := make([]Invite, 0, len(rows))
	for _, r := range rows {
		out = append(out, inviteOf(r.ID, r.Hint, r.MakerID, r.ConversationID, r.Note, r.CreatedAt, r.ExpiresAt))
	}
	return out, err
}

// RevokeInvite ends an open invite. The owner (anyMaker) may revoke any; an agent only its own, and another maker's is as unknown as a
// missing one. A spent, expired or revoked invite is ErrNoInvite too. Run it in a write transaction.
func RevokeInvite(ctx context.Context, d pdb.DBTX, p Ports, id int64, by AuditEntry, anyMaker bool, now time.Time) error {
	q := db.New(d)
	inv, err := q.GetOpenInvite(ctx, db.GetOpenInviteParams{ID: id, Now: now.UnixMilli()})
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !anyMaker && inv.MakerID != by.Actor) {
		return ErrNoInvite
	}
	if err != nil {
		return err
	}
	if n, err := q.RevokeInvite(ctx, db.RevokeInviteParams{ID: id, RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}}); err != nil || n == 0 {
		return errors.Join(err, ErrNoInvite)
	}
	return auditInvite(ctx, d, p, now, by, "invite.revoked", id, map[string]any{"maker_id": inv.MakerID})
}

// TakeInvite finds the open invite a token names. ok is false for a token that names nothing usable: unknown, spent, revoked or
// expired. The caller then answers as if it had accepted the request and makes none. It also writes the expiry of any invite that is
// due, so an attempt with an expired invite leaves its mark at once. Run it in a write transaction that commits when ok is false.
func TakeInvite(ctx context.Context, d pdb.DBTX, p Ports, token string, now time.Time) (Invite, bool, error) {
	if beforeInvites() || token == "" {
		return Invite{}, false, nil
	}
	if _, err := ExpireInvites(ctx, d, p, now); err != nil {
		return Invite{}, false, err
	}
	r, err := db.New(d).GetOpenInviteByHash(ctx, db.GetOpenInviteByHashParams{TokenHash: hashToken(token), Now: now.UnixMilli()})
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, false, nil
	}
	if err != nil {
		return Invite{}, false, err
	}
	return inviteOf(r.ID, r.Hint, r.MakerID, r.ConversationID, r.Note, r.CreatedAt, r.ExpiresAt), true, nil
}

// SpendInvite uses the invite up for the request just made (kind is InviteLogin or InviteSession). Call it in the transaction that
// made the request, so a request that fails gives nothing away.
func SpendInvite(ctx context.Context, d pdb.DBTX, p Ports, inv Invite, kind string, requestID int64, now time.Time) error {
	n, err := db.New(d).SpendInvite(ctx, db.SpendInviteParams{ID: inv.ID, UsedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, UsedKind: sql.NullString{String: kind, Valid: true}, UsedRequestID: sql.NullInt64{Int64: requestID, Valid: true}})
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("the invite was spent already")
	}
	return auditInvite(ctx, d, p, now, AuditEntry{}, "invite.used", inv.ID, map[string]any{"kind": kind, "request_id": requestID, "maker_id": inv.MakerID})
}

// InvitesDue reports whether an unused invite has run out and its expiry is not written yet. It reads only.
func InvitesDue(ctx context.Context, d pdb.DBTX, now time.Time) (bool, error) {
	if beforeInvites() {
		return false, nil
	}
	rows, err := db.New(d).ListInvitesToExpire(ctx, now.UnixMilli())
	return len(rows) > 0, err
}

// ExpireInvites writes the expiry of the unused invites that have run out, with an audit line each, and returns how many. Run it in a
// write transaction.
func ExpireInvites(ctx context.Context, d pdb.DBTX, p Ports, now time.Time) (int, error) {
	if beforeInvites() {
		return 0, nil
	}
	q := db.New(d)
	due, err := q.ListInvitesToExpire(ctx, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	for _, r := range due {
		if err := q.MarkInviteExpired(ctx, db.MarkInviteExpiredParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: r.ID}); err != nil {
			return 0, err
		}
		if err := auditInvite(ctx, d, p, now, AuditEntry{}, "invite.expired", r.ID, map[string]any{"maker_id": r.MakerID}); err != nil {
			return 0, err
		}
	}
	return len(due), nil
}

// InviteMarks maps each waiting request an invite was spent on to the invite's maker and note: logins by the id of their machine
// request, session requests by the id of their identity request.
func InviteMarks(ctx context.Context, d pdb.DBTX, now time.Time) (logins, sessions map[int64]InviteMark, err error) {
	logins, sessions = map[int64]InviteMark{}, map[int64]InviteMark{}
	if beforeInvites() {
		return logins, sessions, nil
	}
	q := db.New(d)
	l, err := q.ListInvitesOfPendingLogins(ctx, now.UnixMilli())
	if err != nil {
		return nil, nil, err
	}
	for _, r := range l {
		logins[r.RequestID.Int64] = InviteMark{MakerID: r.MakerID, Note: r.Note}
	}
	s, err := q.ListInvitesOfPendingSessions(ctx, now.UnixMilli())
	if err != nil {
		return nil, nil, err
	}
	for _, r := range s {
		sessions[r.RequestID.Int64] = InviteMark{MakerID: r.MakerID, Note: r.Note}
	}
	return logins, sessions, nil
}

// FakeDeviceCode is a device code that belongs to no request: the answer to a start that carried no usable invite. It looks like a real
// one and polls like an expired one.
func FakeDeviceCode() string { return newToken(PrefixDeviceReq) }

// FakeIdentityRef is the ref of a session request that was not made, shaped like a real one.
func FakeIdentityRef() string { return newRef() }
