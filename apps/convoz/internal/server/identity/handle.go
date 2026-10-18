package identity

import (
	"context"
	"database/sql"
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
	// HandleChangesPerWindow is how many times an agent's handle may change within HandleWindow.
	HandleChangesPerWindow = 3
	// HandleWindow is the span the limit counts over.
	HandleWindow = 24 * time.Hour
	// HandleGrace is how long the old handle keeps reaching the agent (mentions, `--as old`), with a warning.
	HandleGrace = 30 * 24 * time.Hour
	// HandleWasShown is how long a push title says "@new (was @old)".
	HandleWasShown = 7 * 24 * time.Hour
)

// Refusals of a handle change; the HTTP layer maps each to an answer.
var (
	ErrNotRenamable  = errors.New("only an enabled agent's handle changes")
	ErrHandleChanged = errors.New("the handle changed meanwhile")
)

// HandleRateLimited means the handle changed HandleChangesPerWindow times within HandleWindow; RetryAfter says how long until it may again.
type HandleRateLimited struct{ RetryAfter time.Duration }

func (e *HandleRateLimited) Error() string { return "a handle changes 3 times a day at most" }

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
// of a new handle apply (CheckNewHandle; the agent's own display name excepted: looking like oneself spoofs no one), plus at most
// HandleChangesPerWindow changes in HandleWindow. It reads only.
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
	recent, err := db.New(d).RecentHandleChanges(ctx, db.RecentHandleChangesParams{ID: id, Since: now.Add(-HandleWindow).UnixMilli()})
	if err != nil {
		return "", err
	}
	if len(recent) == HandleChangesPerWindow {
		return "", &HandleRateLimited{RetryAfter: time.UnixMilli(recent[len(recent)-1]).Add(HandleWindow).Sub(now)}
	}
	return st.Handle, checkHandle(ctx, d, to, st.Handle, id)
}

// ChangeHandle gives agent id the handle to, in the caller's transaction. from is the handle the caller saw: the UPDATE names it, so
// of two changes that race the second is ErrHandleChanged. The triggers retire from at once and refuse a retired handle (I-51).
func ChangeHandle(ctx context.Context, d pdb.DBTX, id int64, from, to string, now time.Time) error {
	to = strings.ToLower(to)
	cur, err := CheckHandleChange(ctx, d, id, to, now)
	if err != nil {
		return err
	}
	if cur != from {
		return ErrHandleChanged
	}
	n, err := db.New(d).RenameAgent(ctx, db.RenameAgentParams{ToHandle: to, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id, FromHandle: from})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrHandleChanged
	}
	return nil
}
