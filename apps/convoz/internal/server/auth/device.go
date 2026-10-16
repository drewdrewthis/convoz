package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
)

// Device session rules (design §2.1): 30 days sliding, 90 days absolute, a write at most once a minute.
const (
	DeviceIdle     = 30 * 24 * time.Hour
	DeviceAbsolute = 90 * 24 * time.Hour
	SlideEvery     = time.Minute
)

// Device is a live device session.
type Device struct {
	ID       int64
	HumanID  int64
	Limited  bool
	LastSeen time.Time
	Absolute time.Time // the 90-day end; sliding never goes past it
}

// StartDevice opens a device session and returns the cookie token (shown once, only its hash is stored).
// passkeyID is 0 for a recovery (limited) session.
func StartDevice(ctx context.Context, q *db.Queries, humanID, passkeyID int64, userAgent string, limited bool, now time.Time) (string, int64, error) {
	token := newToken(PrefixDevice)
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	lim := int64(0)
	if limited {
		lim = 1
	}
	id, err := q.InsertDevice(ctx, db.InsertDeviceParams{
		HumanID:           humanID,
		TokenHash:         hashToken(token),
		PasskeyID:         sql.NullInt64{Int64: passkeyID, Valid: passkeyID != 0},
		Label:             "Browser",
		UserAgent:         sql.NullString{String: userAgent, Valid: userAgent != ""},
		Limited:           lim,
		CreatedAt:         now.UnixMilli(),
		ExpiresAt:         now.Add(DeviceIdle).UnixMilli(),
		AbsoluteExpiresAt: now.Add(DeviceAbsolute).UnixMilli(),
	})
	return token, id, err
}

// LookupDevice finds the live device session for a cookie token; ok is false for an unknown, revoked or
// expired one. It reads only: Slide is the separate write.
func LookupDevice(ctx context.Context, q *db.Queries, token string, now time.Time) (Device, bool, error) {
	row, err := q.GetDeviceByTokenHash(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, false, nil
	}
	if err != nil {
		return Device{}, false, err
	}
	n := now.UnixMilli()
	if row.RevokedAt.Valid || n >= row.ExpiresAt || n >= row.AbsoluteExpiresAt {
		return Device{}, false, nil
	}
	return Device{ID: row.ID, HumanID: row.HumanID, Limited: row.Limited == 1, LastSeen: time.UnixMilli(row.LastSeenAt), Absolute: time.UnixMilli(row.AbsoluteExpiresAt)}, true, nil
}

// NeedsSlide reports whether use of d at now should be written (at most once a minute).
func (d Device) NeedsSlide(now time.Time) bool { return now.Sub(d.LastSeen) >= SlideEvery }

// SlideDevice pushes the idle expiry out to 30 days from now, never past the 90-day end.
// It returns the seconds the cookie has left, for a refreshed Max-Age.
func SlideDevice(ctx context.Context, q *db.Queries, d Device, now time.Time) (int, error) {
	expires := now.Add(DeviceIdle)
	if expires.After(d.Absolute) {
		expires = d.Absolute
	}
	if err := q.SlideDevice(ctx, db.SlideDeviceParams{LastSeenAt: now.UnixMilli(), ExpiresAt: expires.UnixMilli(), ID: d.ID}); err != nil {
		return 0, err
	}
	return int(expires.Sub(now) / time.Second), nil
}

// RevokeDevice ends one of the human's device sessions. It reports whether one was live.
func RevokeDevice(ctx context.Context, q *db.Queries, humanID, deviceID int64, reason string, now time.Time) (bool, error) {
	n, err := q.RevokeDevice(ctx, db.RevokeDeviceParams{
		RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		Reason:    sql.NullString{String: reason, Valid: true},
		ID:        deviceID,
		HumanID:   humanID,
	})
	return n > 0, err
}

// DeviceInfo is one row of the device list.
type DeviceInfo struct {
	ID        int64  `json:"id"`
	Label     string `json:"label"`
	Limited   bool   `json:"limited"`
	CreatedAt int64  `json:"created_at"`
	LastSeen  int64  `json:"last_seen_at"`
}

// ListDevices returns the human's live device sessions.
func ListDevices(ctx context.Context, q *db.Queries, humanID int64, now time.Time) ([]DeviceInfo, error) {
	rows, err := q.ListDevices(ctx, db.ListDevicesParams{HumanID: humanID, Now: now.UnixMilli()})
	if err != nil {
		return nil, err
	}
	out := make([]DeviceInfo, 0, len(rows))
	for _, r := range rows {
		out = append(out, DeviceInfo{ID: r.ID, Label: r.Label, Limited: r.Limited == 1, CreatedAt: r.CreatedAt, LastSeen: r.LastSeenAt})
	}
	return out, nil
}
