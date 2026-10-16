package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"math/big"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Device flow limits and times (design §2.2, M6).
const (
	RequestTTL         = 10 * time.Minute // a request is pending this long
	DeliveryTTL        = 10 * time.Minute // after approval the key can be fetched this long
	MaxPendingRequests = 3
	MaxRequestsPerHour = 10
	MaxRequestsPerDay  = 20
	DefaultInterval    = 5 * time.Second
	slowDownStep       = 5 * time.Second
	pollTolerance      = 50 * time.Millisecond
	userCodeAlphabet   = "BCDFGHJKLMNPQRSTVWXZ"
)

// Errors of the device flow.
var (
	ErrTooManyPending = errors.New("three requests are already waiting")
	ErrBadRequest     = errors.New("the request is not valid")
)

// RateLimitedError means a limit is used up; RetryAfter says when the oldest counted item leaves the window.
type RateLimitedError struct{ RetryAfter time.Duration }

func (e *RateLimitedError) Error() string { return "rate limited" }

// retryAfter is the time until the oldest of a window's items is out of it, at least one second.
func retryAfter(oldestMs int64, window time.Duration, now time.Time) time.Duration {
	d := time.UnixMilli(oldestMs).Add(window).Sub(now)
	return max(d, time.Second)
}

// NewUserCode makes a code like "KQWD-MZTP" (not a secret: the owner checks it by eye).
func NewUserCode() string {
	out := make([]byte, 9)
	for i := range out {
		if i == 4 {
			out[i] = '-'
			continue
		}
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(userCodeAlphabet))))
		if err != nil {
			panic("crypto/rand failed: " + err.Error())
		}
		out[i] = userCodeAlphabet[n.Int64()]
	}
	return string(out)
}

// DeviceRequest is what a machine sends to start a login, plus what the server knows about the sender.
type DeviceRequest struct {
	Name       string
	HostInfo   string // JSON, self-reported by the machine
	Source     string // the requesting address
	SourceNode string // the tailnet node name for Source; empty when Tailscale cannot say
	Interval   time.Duration
}

// DeviceCode is the answer to a started login.
type DeviceCode struct {
	DeviceCode string
	UserCode   string
	Interval   time.Duration
	ExpiresIn  time.Duration
}

// RequestDeviceCode starts a login: it checks the pending cap and the per-source limits, then stores the
// request with the SHA-256 of a new device code. nextCode makes user codes; a code that is already pending
// is replaced by a fresh random one.
func RequestDeviceCode(ctx context.Context, d pdb.DBTX, in DeviceRequest, nextCode func() string, now time.Time) (DeviceCode, error) {
	q := db.New(d)
	if !ValidMachineName(in.Name) {
		return DeviceCode{}, ErrBadRequest
	}
	pending, err := q.CountPendingRequests(ctx, now.UnixMilli())
	if err != nil {
		return DeviceCode{}, err
	}
	if pending >= MaxPendingRequests {
		return DeviceCode{}, ErrTooManyPending
	}
	for _, w := range []struct {
		window time.Duration
		max    int64
	}{{time.Hour, MaxRequestsPerHour}, {24 * time.Hour, MaxRequestsPerDay}} {
		row, err := q.RequestsFromSource(ctx, db.RequestsFromSourceParams{Source: in.Source, Since: now.Add(-w.window).UnixMilli()})
		if err != nil {
			return DeviceCode{}, err
		}
		if row.N >= w.max {
			return DeviceCode{}, &RateLimitedError{RetryAfter: retryAfter(row.Oldest, w.window, now)}
		}
	}
	code := newToken(PrefixDeviceReq)
	for attempt := 0; ; attempt++ {
		user := nextCode()
		if attempt > 0 {
			user = NewUserCode()
		}
		_, err = q.InsertMachineRequest(ctx, db.InsertMachineRequestParams{
			DeviceCodeHash: hashToken(code), UserCode: user, RequestedName: in.Name,
			HostInfo:   sql.NullString{String: in.HostInfo, Valid: in.HostInfo != ""},
			Source:     in.Source,
			SourceNode: sql.NullString{String: in.SourceNode, Valid: in.SourceNode != ""},
			CreatedAt:  now.UnixMilli(), ExpiresAt: now.Add(RequestTTL).UnixMilli(), PollIntervalMs: in.Interval.Milliseconds(),
		})
		if err == nil {
			return DeviceCode{DeviceCode: code, UserCode: user, Interval: in.Interval, ExpiresIn: RequestTTL}, nil
		}
		if !pdb.IsUniqueViolation(err) || attempt >= 5 {
			return DeviceCode{}, err
		}
	}
}

// PollOutcome is what a token poll found.
type PollOutcome int

// The outcomes of PollDeviceCode.
const (
	PollPending  PollOutcome = iota // authorization_pending
	PollSlowDown                    // slow_down
	PollDenied                      // access_denied: said once
	PollExpired                     // expired_token: unknown, denied-and-told, expired or delivered
	PollApproved                    // the key is in Key
)

// PollResult is the answer to a token poll. Key, MachineID and MachineName are set for PollApproved.
type PollResult struct {
	Outcome     PollOutcome
	Key         string
	MachineID   int64
	MachineName string
}

// PollDeviceCode answers one token poll. A poll sooner than the request's interval (less 50 ms) is
// slow_down; it counts as a poll and adds 5 s to the interval. Run it in a write transaction.
func PollDeviceCode(ctx context.Context, d pdb.DBTX, box *KeyBox, deviceCode string, now time.Time) (PollResult, error) {
	q := db.New(d)
	r, err := q.GetRequestByDeviceCode(ctx, hashToken(deviceCode))
	if errors.Is(err, sql.ErrNoRows) {
		return PollResult{Outcome: PollExpired}, nil
	}
	if err != nil {
		return PollResult{}, err
	}
	nowMs := now.UnixMilli()
	if nowMs >= r.ExpiresAt || r.State == "delivered" {
		return PollResult{Outcome: PollExpired}, nil
	}
	interval := r.PollIntervalMs
	touch := func(interval int64) error {
		return q.TouchRequestPoll(ctx, db.TouchRequestPollParams{LastPollAt: sql.NullInt64{Int64: nowMs, Valid: true}, PollIntervalMs: interval, ID: r.ID})
	}
	if r.State == "denied" {
		// Said once, on the first poll after the denial (even a hasty one); every later poll is an expired code.
		first := !r.LastPollAt.Valid || r.LastPollAt.Int64 < r.DecidedAt.Int64
		if first {
			return PollResult{Outcome: PollDenied}, touch(interval)
		}
		return PollResult{Outcome: PollExpired}, nil
	}
	if r.LastPollAt.Valid && nowMs-r.LastPollAt.Int64 < interval-pollTolerance.Milliseconds() {
		return PollResult{Outcome: PollSlowDown}, touch(interval + slowDownStep.Milliseconds())
	}
	if err := touch(interval); err != nil {
		return PollResult{}, err
	}
	if r.State == "pending" {
		return PollResult{Outcome: PollPending}, nil
	}
	m, err := q.GetActiveMachine(ctx, r.MachineID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		return PollResult{Outcome: PollExpired}, nil // revoked before the key was fetched
	}
	if err != nil {
		return PollResult{}, err
	}
	key, err := box.Open(m.ID, m.KeyVersion, m.KeyEnc)
	if err != nil {
		return PollResult{}, err
	}
	return PollResult{Outcome: PollApproved, Key: key, MachineID: m.ID, MachineName: m.Name}, nil
}

// Request is a pending machine request as the owner sees it.
type Request struct {
	ID         int64
	Name       string
	UserCode   string
	HostInfo   string // JSON; empty when the machine sent none
	Source     string
	SourceNode string // empty when unknown
	CreatedAt  int64
	ExpiresAt  int64
}

// PendingRequests lists requests that wait for the owner, oldest first.
func PendingRequests(ctx context.Context, d pdb.DBTX, now time.Time) ([]Request, error) {
	rows, err := db.New(d).ListPendingRequests(ctx, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	out := make([]Request, 0, len(rows))
	for _, r := range rows {
		out = append(out, Request{ID: r.ID, Name: r.RequestedName, UserCode: r.UserCode, HostInfo: r.HostInfo.String, Source: r.Source, SourceNode: r.SourceNode.String, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt})
	}
	return out, nil
}

// PendingRequest returns one request that still waits, or ErrNoRequest.
func PendingRequest(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (Request, error) {
	r, err := db.New(d).GetPendingRequest(ctx, db.GetPendingRequestParams{ID: id, Now: now.UnixMilli()})
	if errors.Is(err, sql.ErrNoRows) {
		return Request{}, ErrNoRequest
	}
	if err != nil {
		return Request{}, err
	}
	return Request{ID: r.ID, Name: r.RequestedName, UserCode: r.UserCode, HostInfo: r.HostInfo.String, Source: r.Source, SourceNode: r.SourceNode.String, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt}, nil
}

// CountPendingRequests is how many requests wait for the owner.
func CountPendingRequests(ctx context.Context, d pdb.DBTX, now time.Time) (int64, error) {
	return db.New(d).CountPendingRequests(ctx, now.UnixMilli())
}

// MarkApproved ties a pending request to its new machine and starts the 10-minute pickup window.
func MarkApproved(ctx context.Context, d pdb.DBTX, requestID, machineID, humanID int64, now time.Time) error {
	n, err := db.New(d).ApproveRequest(ctx, db.ApproveRequestParams{
		DecidedBy: sql.NullInt64{Int64: humanID, Valid: true}, DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ExpiresAt: now.Add(DeliveryTTL).UnixMilli(), MachineID: sql.NullInt64{Int64: machineID, Valid: true}, ID: requestID,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNoRequest
	}
	return nil
}

// DenyRequest denies one pending request; ok is false when it was not pending.
func DenyRequest(ctx context.Context, d pdb.DBTX, id, humanID int64, now time.Time) (bool, error) {
	n, err := db.New(d).DenyRequest(ctx, db.DenyRequestParams{DecidedBy: sql.NullInt64{Int64: humanID, Valid: true}, DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id})
	return n > 0, err
}

// DenyAllRequests denies every pending request and returns how many.
func DenyAllRequests(ctx context.Context, d pdb.DBTX, humanID int64, now time.Time) (int64, error) {
	return db.New(d).DenyAllRequests(ctx, db.DenyAllRequestsParams{DecidedBy: sql.NullInt64{Int64: humanID, Valid: true}, DecidedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}})
}
