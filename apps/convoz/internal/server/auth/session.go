package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Lease and budget rules (design §2.2, M5, I-37).
const (
	LeaseTTL            = 12 * time.Hour
	LeaseSlideEvery     = 30 * time.Second // use is written to the lease at most this often
	MaxLiveSessionsEach = 20               // live sessions of one identity
	MaxLiveSessionsOn   = 200              // live sessions on one machine
	MintsPerIdentityHr  = 30
	MintsPerMachineHr   = 300
)

// Errors of the session functions.
var (
	ErrNotAllowed = errors.New("the allow-list does not cover that identity")
	ErrSessionCap = errors.New("too many live sessions")
)

// Session is a lease as the owner sees it in the sessions list.
type Session struct {
	ID         int64
	IdentityID int64
	Machine    string
	ClientID   string
	Label      string
	Live       bool
	EndReason  string
	LastSeenAt int64
	ExpiresAt  int64
}

// leaseInput is a request for a lease; MintSession has already checked that the identity is an enabled agent.
type leaseInput struct {
	Machine    Machine
	IdentityID int64
	Handle     string
	ClientID   string
	Label      string
}

// MintedSession is a new lease with its token (shown once; only the SHA-256 is stored).
type MintedSession struct {
	Handle string // the identity the lease is for
	Lease  string
	Session
	MachineID int64
	Replaced  []int64 // ids of the leases this one replaced; the caller lets go of what they held
}

// mintLease makes a lease in one transaction (the caller's): it ends that client's expired lease, enforces
// the live caps and the hourly budgets, ends the live lease of the same client id ("replaced", M5), inserts
// the new one and marks the machine's device request delivered. The allow-list is also a schema trigger.
func mintLease(ctx context.Context, d pdb.DBTX, in leaseInput, now time.Time) (MintedSession, error) {
	q := db.New(d)
	m, nowMs := in.Machine, now.UnixMilli()
	if !m.Allow.Covers(in.IdentityID, in.Handle) {
		return MintedSession{}, ErrNotAllowed
	}
	if err := q.EndExpiredSessionsOfClient(ctx, db.EndExpiredSessionsOfClientParams{Now: sql.NullInt64{Int64: nowMs, Valid: true}, IdentityID: in.IdentityID, MachineID: m.ID, ClientID: in.ClientID}); err != nil {
		return MintedSession{}, err
	}
	// A re-mint replaces the client's live lease, so that lease does not count against the caps.
	replaced, err := q.CountLiveSessionsOfClient(ctx, db.CountLiveSessionsOfClientParams{IdentityID: in.IdentityID, MachineID: m.ID, ClientID: in.ClientID, Now: nowMs})
	if err != nil {
		return MintedSession{}, err
	}
	live, err := q.CountLiveSessionsOfIdentity(ctx, db.CountLiveSessionsOfIdentityParams{IdentityID: in.IdentityID, Now: nowMs})
	if err != nil {
		return MintedSession{}, err
	}
	onMachine, err := q.CountLiveSessionsOnMachine(ctx, db.CountLiveSessionsOnMachineParams{MachineID: m.ID, Now: nowMs})
	if err != nil {
		return MintedSession{}, err
	}
	if live-replaced >= MaxLiveSessionsEach || onMachine-replaced >= MaxLiveSessionsOn {
		return MintedSession{}, ErrSessionCap
	}
	since := now.Add(-time.Hour).UnixMilli()
	byIdentity, err := q.MintsOfIdentity(ctx, db.MintsOfIdentityParams{IdentityID: in.IdentityID, Since: since})
	if err != nil {
		return MintedSession{}, err
	}
	if byIdentity.N >= MintsPerIdentityHr {
		return MintedSession{}, &RateLimitedError{RetryAfter: retryAfter(byIdentity.Oldest, time.Hour, now)}
	}
	byMachine, err := q.MintsOnMachine(ctx, db.MintsOnMachineParams{MachineID: m.ID, Since: since})
	if err != nil {
		return MintedSession{}, err
	}
	if byMachine.N >= MintsPerMachineHr {
		return MintedSession{}, &RateLimitedError{RetryAfter: retryAfter(byMachine.Oldest, time.Hour, now)}
	}
	replacedIDs, err := q.EndOpenSessionsOfClient(ctx, db.EndOpenSessionsOfClientParams{Now: sql.NullInt64{Int64: nowMs, Valid: true}, IdentityID: in.IdentityID, MachineID: m.ID, ClientID: in.ClientID})
	if err != nil {
		return MintedSession{}, err
	}
	lease := newToken(PrefixSession)
	expires := now.Add(LeaseTTL).UnixMilli()
	id, err := q.InsertSession(ctx, db.InsertSessionParams{
		IdentityID: in.IdentityID, MachineID: m.ID, TokenHash: hashToken(lease), ClientID: in.ClientID, Label: in.Label,
		Scopes: m.Scopes, Now: nowMs, ExpiresAt: expires,
	})
	if err != nil {
		if pdb.IsTriggerAbort(err) {
			return MintedSession{}, ErrNotAllowed
		}
		return MintedSession{}, err
	}
	if err := q.MarkRequestDelivered(ctx, sql.NullInt64{Int64: m.ID, Valid: true}); err != nil {
		return MintedSession{}, err
	}
	if err := q.TouchMachine(ctx, db.TouchMachineParams{LastUsedAt: sql.NullInt64{Int64: nowMs, Valid: true}, ID: m.ID}); err != nil {
		return MintedSession{}, err
	}
	return MintedSession{Lease: lease, MachineID: m.ID, Replaced: replacedIDs, Session: Session{ID: id, IdentityID: in.IdentityID, Machine: m.Name, ClientID: in.ClientID, Label: in.Label, Live: true, LastSeenAt: nowMs, ExpiresAt: expires}}, nil
}

// Lease is the authenticated lease behind a bearer token.
type Lease struct {
	SessionID  int64
	IdentityID int64
	MachineID  int64
	Machine    string
	ClientID   string
	Label      string
	Scopes     int64
	LastSeenAt int64
	ExpiresAt  int64
}

// LeaseDead says why a token no longer works.
type LeaseDead struct{ Reason string } // an end reason, or "expired"

// LookupLease finds the live lease for a token. When the token is a lease that ended or ran out, dead says
// why (ok is false); for an unknown token both are zero. It reads only: Slide is the separate write.
func LookupLease(ctx context.Context, d pdb.DBTX, token string, now time.Time) (l Lease, dead *LeaseDead, ok bool, err error) {
	r, err := db.New(d).GetSessionByTokenHash(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return Lease{}, nil, false, nil
	}
	if err != nil {
		return Lease{}, nil, false, err
	}
	switch {
	case r.EndedAt.Valid:
		return Lease{}, &LeaseDead{Reason: r.EndReason.String}, false, nil
	case now.UnixMilli() >= r.ExpiresAt:
		return Lease{}, &LeaseDead{Reason: "expired"}, false, nil
	}
	return Lease{SessionID: r.ID, IdentityID: r.IdentityID, MachineID: r.MachineID, Machine: r.MachineName, ClientID: r.ClientID, Label: r.Label, Scopes: r.Scopes, LastSeenAt: r.LastSeenAt, ExpiresAt: r.ExpiresAt}, nil, true, nil
}

// NeedsSlide reports whether use of the lease at now should be written (at most every 30 seconds).
func (l Lease) NeedsSlide(now time.Time) bool {
	return now.Sub(time.UnixMilli(l.LastSeenAt)) >= LeaseSlideEvery
}

// SlideLease moves the expiry to now + 12 hours and returns it. Every authenticated call does this (throttled
// by NeedsSlide), and POST /api/sessions/renew does it unconditionally.
func SlideLease(ctx context.Context, d pdb.DBTX, l Lease, now time.Time) (int64, error) {
	expires := now.Add(LeaseTTL).UnixMilli()
	err := db.New(d).SlideSession(ctx, db.SlideSessionParams{Now: now.UnixMilli(), ExpiresAt: expires, ID: l.SessionID})
	return expires, err
}

// EndLease ends one lease; ok is false when it was already over.
func EndLease(ctx context.Context, d pdb.DBTX, sessionID int64, reason string, now time.Time) (bool, error) {
	n, err := db.New(d).EndSession(ctx, db.EndSessionParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: reason, Valid: true}, ID: sessionID})
	return n > 0, err
}

// EndMachineSessions ends every open lease of a machine (key regenerated, machine revoked) and returns their ids,
// so the caller can let go of what those leases held.
func EndMachineSessions(ctx context.Context, d pdb.DBTX, machineID int64, reason string, now time.Time) ([]int64, error) {
	return db.New(d).EndSessionsOfMachine(ctx, db.EndSessionsOfMachineParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: reason, Valid: true}, MachineID: machineID})
}

// EndIdentitySessions ends every open lease of an identity on every machine (the identity was disabled); it returns their ids.
func EndIdentitySessions(ctx context.Context, d pdb.DBTX, identityID int64, reason string, now time.Time) ([]int64, error) {
	return db.New(d).EndSessionsOfIdentity(ctx, db.EndSessionsOfIdentityParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: reason, Valid: true}, IdentityID: identityID})
}

// EndMachineIdentitySessions ends the open leases of one identity on one machine only (it left the allow-list); it returns their ids.
func EndMachineIdentitySessions(ctx context.Context, d pdb.DBTX, machineID, identityID int64, reason string, now time.Time) ([]int64, error) {
	return db.New(d).EndSessionsOfIdentityOnMachine(ctx, db.EndSessionsOfIdentityOnMachineParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: reason, Valid: true}, IdentityID: identityID, MachineID: machineID})
}

// LiveSessionIdentities lists the identities that have a live lease on the machine.
func LiveSessionIdentities(ctx context.Context, d pdb.DBTX, machineID int64, now time.Time) ([]int64, error) {
	return db.New(d).LiveSessionIdentitiesOnMachine(ctx, db.LiveSessionIdentitiesOnMachineParams{MachineID: machineID, Now: now.UnixMilli()})
}

// LiveSessionCount is how many live leases an identity has on all machines.
func LiveSessionCount(ctx context.Context, d pdb.DBTX, identityID int64, now time.Time) (int64, error) {
	return db.New(d).CountLiveSessionsOfIdentity(ctx, db.CountLiveSessionsOfIdentityParams{IdentityID: identityID, Now: now.UnixMilli()})
}

// ListSessions returns the newest sessions first, at most max. A lease past its expiry that nobody ended is
// shown as ended with the reason "expired".
func ListSessions(ctx context.Context, d pdb.DBTX, max int, now time.Time) ([]Session, error) {
	rows, err := db.New(d).ListSessions(ctx, int64(max))
	if err != nil {
		return nil, err
	}
	out := make([]Session, 0, len(rows))
	for _, r := range rows {
		s := Session{ID: r.ID, IdentityID: r.IdentityID, Machine: r.MachineName, ClientID: r.ClientID, Label: r.Label, LastSeenAt: r.LastSeenAt, ExpiresAt: r.ExpiresAt, EndReason: r.EndReason.String}
		switch {
		case r.EndedAt.Valid:
		case now.UnixMilli() >= r.ExpiresAt:
			s.EndReason = "expired"
		default:
			s.Live = true
		}
		out = append(out, s)
	}
	return out, nil
}
