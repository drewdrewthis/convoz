package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// An agent's handle can change (I-51). Owner (2026-10-18): "Handles I think can also change, that seems fine because there's an
// id, right?" Earlier: "the handle is never reused." Every record keys on the identity id, so only the handle text moves; the old
// handle is retired in the same transaction and keeps naming the agent in mentions.
const (
	// HandleEvery is how often an agent's handle may change.
	HandleEvery = 30 * 24 * time.Hour
	// HandleGrace is how long `--as old` keeps working after a change, with a warning.
	HandleGrace = 30 * 24 * time.Hour
	// HandleWasShown is how long a push title says "@new (was @old)".
	HandleWasShown = 7 * 24 * time.Hour
	// HandleRequestTTL is how long an agent's request waits for the owner.
	HandleRequestTTL = 24 * time.Hour
)

// Handle request states; "expired" is never stored (expiry is by time).
const (
	HandlePending   = "pending"
	HandleApproved  = "approved"
	HandleDenied    = "denied"
	HandleWithdrawn = "withdrawn"
	HandleExpired   = "expired"
)

// Refusals of a handle change; the HTTP layer maps each to an answer.
var (
	ErrNotRenamable    = errors.New("only an enabled agent's handle changes")
	ErrHandleChanged   = errors.New("the handle changed meanwhile")
	ErrNoHandleRequest = errors.New("no such handle request")
)

// HandleRateLimited means the handle changed less than HandleEvery ago; RetryAfter says how long until it may again.
type HandleRateLimited struct{ RetryAfter time.Duration }

func (e *HandleRateLimited) Error() string { return "a handle changes once in 30 days" }

// Retired is a handle an identity had before, and when it gave it up (epoch ms).
type Retired struct {
	Handle    string
	RetiredAt int64
}

// Resolve finds who a handle names: the identity that has it now, else the one that had it before. A retired handle is never
// reused, so it names at most one identity, and a change is one transaction, so a reader finds the same id before and after it.
// retired is set in the second case.
func Resolve(ctx context.Context, d pdb.DBTX, handle string) (p Principal, retired *Retired, found bool, err error) {
	if p, found, err = Lookup(ctx, d, handle); err != nil || found {
		return p, nil, found, err
	}
	r, err := db.New(d).GetRetiredHandle(ctx, handle)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, nil, false, nil
	}
	if err != nil {
		return Principal{}, nil, false, err
	}
	p = Principal{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Disabled: r.DisabledAt.Valid}
	return p, &Retired{Handle: r.Retired, RetiredAt: r.RetiredAt}, true, nil
}

// RetiredOf lists the handles an identity had before, newest first.
func RetiredOf(ctx context.Context, d pdb.DBTX, id int64) ([]Retired, error) {
	rows, err := db.New(d).RetiredHandlesOf(ctx, id)
	out := make([]Retired, 0, len(rows))
	for _, r := range rows {
		out = append(out, Retired{Handle: r.Handle, RetiredAt: r.RetiredAt})
	}
	return out, err
}

// WasHandle is the handle an agent gave up at its last change, while that change is less than HandleWasShown old.
func WasHandle(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (string, bool, error) {
	r, err := db.New(d).LastRetiredHandle(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return r.Handle, now.Sub(time.UnixMilli(r.RetiredAt)) < HandleWasShown, nil
}

// CheckHandleChange runs every rule for agent id to take the handle to (lowercase) now, and returns its handle as it is. The rules
// of a new handle apply (CheckNewHandle; the agent's own display name excepted: looking like oneself spoofs no one), plus one
// change in HandleEvery. It reads only.
func CheckHandleChange(ctx context.Context, d pdb.DBTX, id int64, to string, now time.Time) (from string, err error) {
	st, err := db.New(d).GetHandleState(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotAgent
	}
	if err != nil {
		return "", err
	}
	if st.Kind != "agent" || st.DisabledAt.Valid {
		return "", ErrNotRenamable
	}
	if st.HandleChangedAt.Valid {
		if wait := time.UnixMilli(st.HandleChangedAt.Int64).Add(HandleEvery).Sub(now); wait > 0 {
			return "", &HandleRateLimited{RetryAfter: wait}
		}
	}
	return st.Handle, checkHandle(ctx, d, to, st.Handle)
}

// ChangeHandle gives agent id the handle to, in the caller's transaction. from is the handle the caller saw: the UPDATE names it, so
// of two changes that race the second is ErrHandleChanged. The triggers retire from at once and refuse a retired handle (I-51).
// A request of the agent that still waits is withdrawn.
func ChangeHandle(ctx context.Context, d pdb.DBTX, id int64, from, to string, now time.Time) error {
	to = strings.ToLower(to)
	cur, err := CheckHandleChange(ctx, d, id, to, now)
	if err != nil {
		return err
	}
	if cur != from {
		return ErrHandleChanged
	}
	q := db.New(d)
	n, err := q.RenameAgent(ctx, db.RenameAgentParams{ToHandle: to, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id, FromHandle: from})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrHandleChanged
	}
	return q.WithdrawHandleRequests(ctx, db.WithdrawHandleRequestsParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, IdentityID: id})
}

// HandleRequest is an agent's request for a new handle.
type HandleRequest struct {
	ID          int64
	Ref         string
	IdentityID  int64
	From        string
	To          string
	State       string
	DisplayName string
	CreatedAt   int64
	ExpiresAt   int64
}

func newHandleRef() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return "hdr_" + hex.EncodeToString(b)
}

func handleRequestOf(id int64, ref string, identityID int64, from, to, state string, created, expires int64) HandleRequest {
	return HandleRequest{ID: id, Ref: ref, IdentityID: identityID, From: from, To: to, State: state, CreatedAt: created, ExpiresAt: expires}
}

// FileHandleRequest files agent id's request for the handle to. The rules run now and again on approval, so the request reserves
// nothing. Asking again for the same handle gives the waiting request back (filed is false); asking for another withdraws it.
func FileHandleRequest(ctx context.Context, d pdb.DBTX, id int64, to string, now time.Time) (r HandleRequest, filed bool, err error) {
	to = strings.ToLower(to)
	from, err := CheckHandleChange(ctx, d, id, to, now)
	if err != nil {
		return HandleRequest{}, false, err
	}
	q := db.New(d)
	w, err := q.PendingHandleRequestOf(ctx, id)
	switch {
	case err == nil && w.ToHandle == to && w.FromHandle == from && now.UnixMilli() < w.ExpiresAt:
		return handleRequestOf(w.ID, w.Ref, w.IdentityID, w.FromHandle, w.ToHandle, w.State, w.CreatedAt, w.ExpiresAt), false, nil
	case err == nil:
		if err := q.WithdrawHandleRequests(ctx, db.WithdrawHandleRequestsParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, IdentityID: id}); err != nil {
			return HandleRequest{}, false, err
		}
	case !errors.Is(err, sql.ErrNoRows):
		return HandleRequest{}, false, err
	}
	ref, expires := newHandleRef(), now.Add(HandleRequestTTL).UnixMilli()
	rid, err := q.InsertHandleRequest(ctx, db.InsertHandleRequestParams{Ref: ref, IdentityID: id, FromHandle: from, ToHandle: to, CreatedAt: now.UnixMilli(), ExpiresAt: expires})
	if err != nil {
		return HandleRequest{}, false, err
	}
	return handleRequestOf(rid, ref, id, from, to, HandlePending, now.UnixMilli(), expires), true, nil
}

// HandleRequestFor is how the agent learns what became of its request. A ref that is unknown or another agent's is
// ErrNoHandleRequest, the same answer for both. A waiting request past its time reads HandleExpired.
func HandleRequestFor(ctx context.Context, d pdb.DBTX, identityID int64, ref string, now time.Time) (HandleRequest, error) {
	w, err := db.New(d).GetHandleRequestByRef(ctx, ref)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && w.IdentityID != identityID) {
		return HandleRequest{}, ErrNoHandleRequest
	}
	if err != nil {
		return HandleRequest{}, err
	}
	r := handleRequestOf(w.ID, w.Ref, w.IdentityID, w.FromHandle, w.ToHandle, w.State, w.CreatedAt, w.ExpiresAt)
	if r.State == HandlePending && now.UnixMilli() >= r.ExpiresAt {
		r.State = HandleExpired
	}
	return r, nil
}

// PendingHandleRequests lists the requests that wait for the owner, oldest first: not expired, of an enabled agent whose handle is
// still the one the request started from.
func PendingHandleRequests(ctx context.Context, d pdb.DBTX, now time.Time) ([]HandleRequest, error) {
	if beforeHandleChange() {
		return nil, nil
	}
	rows, err := db.New(d).ListPendingHandleRequests(ctx, now.UnixMilli())
	out := make([]HandleRequest, 0, len(rows))
	for _, w := range rows {
		r := handleRequestOf(w.ID, w.Ref, w.IdentityID, w.FromHandle, w.ToHandle, w.State, w.CreatedAt, w.ExpiresAt)
		r.DisplayName = w.DisplayName
		out = append(out, r)
	}
	return out, err
}

// DecideHandleRequest records the owner's tap on a waiting request, in the caller's transaction, and returns the request. An
// approval is followed in the same transaction by the change itself (ChangeHandle runs every rule again: the handle may have been
// taken since). A request that is not waiting any more is ErrNoHandleRequest.
func DecideHandleRequest(ctx context.Context, d pdb.DBTX, ref string, human int64, approve bool, now time.Time) (HandleRequest, error) {
	q := db.New(d)
	w, err := q.GetHandleRequestByRef(ctx, ref)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (w.State != HandlePending || now.UnixMilli() >= w.ExpiresAt)) {
		return HandleRequest{}, ErrNoHandleRequest
	}
	if err != nil {
		return HandleRequest{}, err
	}
	r := handleRequestOf(w.ID, w.Ref, w.IdentityID, w.FromHandle, w.ToHandle, HandleDenied, w.CreatedAt, w.ExpiresAt)
	if approve {
		r.State = HandleApproved
	}
	_, err = q.DecideHandleRequest(ctx, db.DecideHandleRequestParams{
		State: r.State, DecidedBy: sql.NullInt64{Int64: human, Valid: true}, DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: w.ID,
	})
	return r, err
}
