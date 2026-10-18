package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits of an identity request (owner decision: the agent sends its own identity, the owner approves it on one card).
const (
	// IdentityRequestTTL is how long a request from a logged-in machine waits for the owner. A login request lives as long as its
	// device-flow request (10 minutes): the person at the terminal is waiting for it.
	IdentityRequestTTL = 24 * time.Hour
	// IdentityRequestsPerDay is how many requests one machine may file in 24 hours, decided or not.
	IdentityRequestsPerDay = 5
	// MaxIntroRunes is the longest description: the agent profile column holds 80, and the description becomes the profile.
	MaxIntroRunes = 80
)

// Identity request kinds and states.
const (
	KindLogin     = "login"   // rides on a device-flow request: one Approve makes the machine and the identity
	KindSession   = "session" // a logged-in machine asks for an identity it may not create itself
	StatePending  = "pending"
	StateApproved = "approved"
	StateDenied   = "denied"
	StateExpired  = "expired"
)

// ErrIdentityGone means the request is not pending any more: decided, expired, or its machine is gone.
var ErrIdentityGone = errors.New("the identity request is gone")

// IdentityPackage is the identity an agent sends about itself. The handle is the only required part.
type IdentityPackage struct {
	Handle         string
	DisplayName    string // empty: the handle
	Description    string // plain text, one line
	AvatarSVG      string // already cleaned by the caller (I-32)
	ConversationID int64  // 0: none
}

// IdentityRequest is a stored request as the owner sees it.
type IdentityRequest struct {
	ID               int64
	Ref              string
	Kind             string
	MachineRequestID int64
	MachineID        int64
	MachineName      string
	Handle           string
	DisplayName      string
	Description      string
	HasAvatar        bool
	ConversationID   int64
	State            string
	CreatedAt        int64
	ExpiresAt        int64
	IdentityID       int64
}

func newRef() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return "idr_" + hex.EncodeToString(b)
}

// ValidIntro reports whether s can be the description of a request: one line of plain text, no control or format
// characters (bidi marks, zero-width), at most MaxIntroRunes.
func ValidIntro(s string) bool {
	return utf8.RuneCountInString(s) <= MaxIntroRunes && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

// CheckIdentityPackage normalizes the package and runs every rule it must meet now: the handle and display name (valid, reserved,
// taken, retired, look-alike), the description, and the conversation (a live one the owner is in). It reads only, so a request
// reserves nothing; the approval runs the same rules again.
func CheckIdentityPackage(ctx context.Context, d pdb.DBTX, p Ports, in IdentityPackage) (IdentityPackage, error) {
	in.Handle = strings.ToLower(strings.TrimSpace(in.Handle))
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	if !ValidIntro(in.Description) {
		return in, &FieldError{Field: "description", Message: "A description is one line of plain text, up to 80 characters."}
	}
	name := in.DisplayName
	if name == "" {
		name = in.Handle
	}
	if err := p.Agents.CheckNew(ctx, d, in.Handle, name); err != nil {
		return in, err
	}
	if in.ConversationID != 0 {
		if _, ok, err := p.Conversations.OwnerConversation(ctx, d, in.ConversationID); err != nil {
			return in, err
		} else if !ok {
			return in, &FieldError{Field: "conversation", Message: "That conversation is not available."}
		}
	}
	return in, nil
}

func nullInt(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: n != 0} }

func nullText(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

func (in IdentityPackage) insertParams(kind string, now time.Time, ttl time.Duration) db.InsertIdentityRequestParams {
	return db.InsertIdentityRequestParams{
		Ref: newRef(), Kind: kind, Handle: in.Handle, DisplayName: nullText(in.DisplayName), Description: in.Description,
		AvatarSvg: nullText(in.AvatarSVG), ConversationID: nullInt(in.ConversationID), CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli(),
	}
}

// AttachLoginIdentity stores the identity a device-flow request carries. The package was checked by CheckIdentityPackage.
func AttachLoginIdentity(ctx context.Context, d pdb.DBTX, machineRequestID int64, in IdentityPackage, now time.Time) error {
	arg := in.insertParams(KindLogin, now, RequestTTL)
	arg.MachineRequestID = nullInt(machineRequestID)
	_, err := db.New(d).InsertIdentityRequest(ctx, arg)
	return err
}

// IdentityFiled is the answer to a session request: the ref the machine polls with, and when the request lapses.
type IdentityFiled struct {
	Ref       string
	ExpiresAt int64
}

// FileSessionIdentity files the request of a logged-in machine that may not create identities itself. The same machine asking again for
// the same handle gets its waiting request back. A machine files at most IdentityRequestsPerDay requests in 24 hours. Run it in a write
// transaction; it writes the audit line and the event that wakes Now.
func FileSessionIdentity(ctx context.Context, d pdb.DBTX, p Ports, m Machine, in IdentityPackage, now time.Time) (IdentityFiled, error) {
	q := db.New(d)
	in, err := CheckIdentityPackage(ctx, d, p, in)
	if err != nil {
		return IdentityFiled{}, err
	}
	if waiting, err := q.FindPendingIdentityRequestOfMachine(ctx, db.FindPendingIdentityRequestOfMachineParams{MachineID: nullInt(m.ID), Handle: in.Handle, Now: now.UnixMilli()}); err == nil {
		return IdentityFiled{Ref: waiting.Ref, ExpiresAt: waiting.ExpiresAt}, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return IdentityFiled{}, err
	}
	since := now.Add(-24 * time.Hour)
	row, err := q.CountIdentityRequestsOfMachineSince(ctx, db.CountIdentityRequestsOfMachineSinceParams{MachineID: nullInt(m.ID), Since: since.UnixMilli()})
	if err != nil {
		return IdentityFiled{}, err
	}
	if row.N >= IdentityRequestsPerDay {
		return IdentityFiled{}, &RateLimitedError{RetryAfter: retryAfter(row.Oldest, 24*time.Hour, now)}
	}
	arg := in.insertParams(KindSession, now, IdentityRequestTTL)
	arg.MachineID = nullInt(m.ID)
	id, err := q.InsertIdentityRequest(ctx, arg)
	if err != nil {
		return IdentityFiled{}, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Machine: m.ID, Action: "identity.requested", TargetKind: "identity_request", TargetID: id}); err != nil {
		return IdentityFiled{}, err
	}
	if err := p.Journal.Event(ctx, d, now, "identity.requested.v1", map[string]any{"request_id": id, "machine_id": m.ID}); err != nil {
		return IdentityFiled{}, err
	}
	return IdentityFiled{Ref: arg.Ref, ExpiresAt: arg.ExpiresAt}, nil
}

// PollIdentity is how the requesting machine learns what became of its request. A ref that is unknown, or belongs to another
// machine, is ErrNoIdentityRequest, the same answer for both, so a machine learns nothing about requests that are not its own.
func PollIdentity(ctx context.Context, d pdb.DBTX, machineID int64, ref string, now time.Time) (state string, expiresAt int64, err error) {
	r, err := db.New(d).GetIdentityRequestByRef(ctx, ref)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (r.Kind != KindSession || r.MachineID.Int64 != machineID)) {
		return "", 0, ErrNoIdentityRequest
	}
	if err != nil {
		return "", 0, err
	}
	if r.State == StatePending && now.UnixMilli() >= r.ExpiresAt {
		return StateExpired, r.ExpiresAt, nil
	}
	return r.State, r.ExpiresAt, nil
}

func requestOf(id int64, ref, kind string, mreq, machine sql.NullInt64, name, handle string, display sql.NullString, desc string, hasAvatar int64, conv sql.NullInt64, state string, created, expires int64, identity sql.NullInt64) IdentityRequest {
	return IdentityRequest{
		ID: id, Ref: ref, Kind: kind, MachineRequestID: mreq.Int64, MachineID: machine.Int64, MachineName: name, Handle: handle, DisplayName: display.String,
		Description: desc, HasAvatar: hasAvatar == 1, ConversationID: conv.Int64, State: state, CreatedAt: created, ExpiresAt: expires, IdentityID: identity.Int64,
	}
}

// PendingIdentityRequests lists the waiting requests of logged-in machines, oldest first.
func PendingIdentityRequests(ctx context.Context, d pdb.DBTX, now time.Time) ([]IdentityRequest, error) {
	rows, err := db.New(d).ListPendingSessionIdentityRequests(ctx, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	out := make([]IdentityRequest, 0, len(rows))
	for _, r := range rows {
		out = append(out, requestOf(r.ID, r.Ref, r.Kind, r.MachineRequestID, r.MachineID, r.MachineName, r.Handle, r.DisplayName, r.Description, r.HasAvatar, r.ConversationID, r.State, r.CreatedAt, r.ExpiresAt, r.IdentityID))
	}
	return out, nil
}

// LoginIdentityRequests maps each waiting device-flow request that carries an identity to that identity.
func LoginIdentityRequests(ctx context.Context, d pdb.DBTX, now time.Time) (map[int64]IdentityRequest, error) {
	rows, err := db.New(d).ListPendingLoginIdentityRequests(ctx, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	out := make(map[int64]IdentityRequest, len(rows))
	for _, r := range rows {
		out[r.MachineRequestID.Int64] = requestOf(r.ID, r.Ref, r.Kind, r.MachineRequestID, r.MachineID, r.MachineName, r.Handle, r.DisplayName, r.Description, r.HasAvatar, r.ConversationID, r.State, r.CreatedAt, r.ExpiresAt, r.IdentityID)
	}
	return out, nil
}

// IdentityAvatar is the cleaned SVG a pending request carries; ok is false when it has none.
func IdentityAvatar(ctx context.Context, d pdb.DBTX, ref string) (svg string, ok bool, err error) {
	v, err := db.New(d).GetIdentityRequestAvatar(ctx, ref)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v.String, err == nil && v.Valid, err
}

// loginIdentityOf returns the identity request riding on a device-flow request; found is false when it carries none.
func loginIdentityOf(ctx context.Context, d pdb.DBTX, machineRequestID int64) (r db.GetIdentityRequestOfLoginRow, found bool, err error) {
	r, err = db.New(d).GetIdentityRequestOfLogin(ctx, nullInt(machineRequestID))
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	return r, err == nil, err
}

// makeRequestedIdentity creates the agent a request asks for, on behalf of the machine, and applies what the agent said about itself:
// description, avatar and the conversation. The checks run again here: the handle may have been taken since the request was filed.
func makeRequestedIdentity(ctx context.Context, d pdb.DBTX, p Ports, human Human, machineID, requestID int64, now time.Time) (Agent, error) {
	q := db.New(d)
	var (
		handle, desc string
		display      sql.NullString
		conv         int64
		avatar       sql.NullString
		ref          string
	)
	rows, err := q.GetIdentityRequestByID(ctx, requestID)
	if err != nil {
		return Agent{}, err
	}
	handle, desc, display, conv, ref = rows.Handle, rows.Description, rows.DisplayName, rows.ConversationID.Int64, rows.Ref
	if _, err := CheckIdentityPackage(ctx, d, p, IdentityPackage{Handle: handle, DisplayName: display.String, Description: desc, ConversationID: conv}); err != nil {
		return Agent{}, err
	}
	name := display.String
	if name == "" {
		name = handle
	}
	made, err := p.Agents.Create(ctx, d, NewAgent{Handle: handle, DisplayName: name, ByMachine: machineID}, now)
	if err != nil {
		return Agent{}, err
	}
	if avatar, err = q.GetIdentityRequestAvatar(ctx, ref); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Agent{}, err
	}
	if err := p.Agents.SetIntro(ctx, d, made.ID, desc, avatar.String); err != nil {
		return Agent{}, err
	}
	if n, err := q.ApproveIdentityRequest(ctx, db.ApproveIdentityRequestParams{
		DecidedBy: nullInt(human.ID), DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, IdentityID: nullInt(made.ID), ID: requestID,
	}); err != nil {
		return Agent{}, err
	} else if n == 0 {
		return Agent{}, ErrIdentityGone
	}
	if conv != 0 {
		if err := p.Conversations.Join(ctx, d, now, conv, made.ID, human.ID); err != nil {
			return Agent{}, err
		}
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: human.ID, Machine: machineID, Action: "identity.created", TargetKind: "identity", TargetID: made.ID}); err != nil {
		return Agent{}, err
	}
	return made, p.Journal.Event(ctx, d, now, "identity.created.v1", map[string]any{"identity_id": made.ID, "machine_id": machineID})
}

// addToAllow lets the machine act as the new agent. A machine that allows every agent needs no entry.
func addToAllow(ctx context.Context, d pdb.DBTX, machineID, agentID int64, now time.Time) error {
	m, err := MachineByID(ctx, d, machineID, now)
	if err != nil {
		return err
	}
	if m.Allow.Mode == AllowAny {
		return nil
	}
	m.Allow.IdentityIDs = append(m.Allow.IdentityIDs, agentID)
	return ReplaceAllow(ctx, d, machineID, m.Allow)
}

// IdentityApproval is the owner's decision on a request of a logged-in machine.
type IdentityApproval struct {
	Ref      string
	Human    Human
	DeviceID int64
}

// ApprovedIdentity is what an approval made.
type ApprovedIdentity struct {
	Agent          Agent
	MachineID      int64
	MachineName    string
	ConversationID int64
}

// ApproveIdentity turns a waiting request of a logged-in machine into an agent that machine may act as, inside the open transaction.
// The owner's signed-in session is the authority; there is no passkey check. It checks every rule again, makes the identity, lets the machine use it, and joins the conversation when the request named one.
func ApproveIdentity(ctx context.Context, d pdb.DBTX, p Ports, in IdentityApproval, now time.Time) (ApprovedIdentity, error) {
	q := db.New(d)
	r, err := q.GetIdentityRequestByRef(ctx, in.Ref)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (r.Kind != KindSession || r.State != StatePending || now.UnixMilli() >= r.ExpiresAt)) {
		return ApprovedIdentity{}, ErrIdentityGone
	}
	if err != nil {
		return ApprovedIdentity{}, err
	}
	machineID := r.MachineID.Int64
	machine, err := MachineByID(ctx, d, machineID, now)
	if err != nil {
		return ApprovedIdentity{}, ErrIdentityGone
	}
	made, err := makeRequestedIdentity(ctx, d, p, in.Human, machine.ID, r.ID, now)
	if err != nil {
		return ApprovedIdentity{}, err
	}
	if err := addToAllow(ctx, d, machine.ID, made.ID, now); err != nil {
		return ApprovedIdentity{}, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Machine: machine.ID, Action: "machine.allow_changed", TargetKind: "machine", TargetID: machine.ID}); err != nil {
		return ApprovedIdentity{}, err
	}
	if err := p.Journal.Event(ctx, d, now, "machine.allow_changed.v1", map[string]any{"machine_id": machine.ID}); err != nil {
		return ApprovedIdentity{}, err
	}
	return ApprovedIdentity{Agent: made, MachineID: machine.ID, MachineName: machine.Name, ConversationID: r.ConversationID.Int64}, nil
}

// DenyIdentity denies one waiting request of a logged-in machine; ok is false when it was not waiting.
func DenyIdentity(ctx context.Context, d pdb.DBTX, j JournalPort, human Human, deviceID int64, ref string, now time.Time) (bool, error) {
	n, err := db.New(d).DenyIdentityRequest(ctx, db.DenyIdentityRequestParams{DecidedBy: nullInt(human.ID), DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Ref: ref})
	if err != nil || n == 0 {
		return false, err
	}
	return true, j.Audit(ctx, d, now, AuditEntry{Actor: human.ID, Device: deviceID, Action: "identity.denied", TargetKind: "identity_request"})
}
