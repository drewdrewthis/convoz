package notify

import (
	"context"
	"crypto/elliptic"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Why a subscription stopped (the disabled_reason column).
const (
	DisabledGone          = "gone"           // the push service said 404 or 410
	DisabledFailures      = "failures"       // too many failed pushes in a row
	DisabledDeviceRevoked = "device_revoked" // the device was signed out
	DisabledUser          = "user"           // the owner turned push off, or the device subscribed again
)

// Errors of Subscribe; the HTTP layer answers 400 with the field.
var (
	ErrBadEndpoint = errors.New("the endpoint must be https on a known push service")
	ErrBadKeys     = errors.New("the keys must be the browser's p256dh (65 bytes) and auth (16 bytes), base64url")
)

// Subscription is one device's push subscription as the owner sees it. The endpoint is not part of it: it is a capability to send to the device.
type Subscription struct {
	ID             int64
	DeviceID       int64
	Host           string
	CreatedAt      int64
	LastSuccessAt  int64
	DisabledAt     int64
	DisabledReason string
}

// Active reports whether pushes still go to it.
func (s Subscription) Active() bool { return s.DisabledAt == 0 }

// NewSubscription is what the browser's PushSubscription says.
type NewSubscription struct {
	Device, Person int64
	Endpoint       string
	P256dh, Auth   string // base64url (the browser's own encoding)
}

// decodeKey reads base64url with or without padding, or standard base64: the forms browsers and tests produce.
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// Subscribe stores the device's subscription. A device has one live subscription, so an earlier one of the device ends (reason user).
// The same endpoint again is the same subscription made live again with the new keys.
func Subscribe(ctx context.Context, d pdb.DBTX, now time.Time, in NewSubscription) (Subscription, error) {
	if !AllowedEndpoint(in.Endpoint) {
		return Subscription{}, ErrBadEndpoint
	}
	p256dh, err1 := decodeKey(in.P256dh)
	auth, err2 := decodeKey(in.Auth)
	if err1 != nil || err2 != nil || len(p256dh) != 65 || len(auth) != 16 {
		return Subscription{}, ErrBadKeys
	}
	if x, _ := elliptic.Unmarshal(elliptic.P256(), p256dh); x == nil {
		return Subscription{}, ErrBadKeys
	}
	q := db.New(d)
	at := sql.NullInt64{Int64: now.UnixMilli(), Valid: true}
	why := sql.NullString{String: DisabledUser, Valid: true}
	existing, err := q.SubscriptionByEndpoint(ctx, in.Endpoint)
	var id int64
	switch {
	case err == nil:
		id = existing.ID
		if err := q.DisableDeviceSubscriptions(ctx, db.DisableDeviceSubscriptionsParams{Now: at, Reason: why, DeviceID: in.Device, Keep: id}); err != nil {
			return Subscription{}, err
		}
		err = q.ReviveSubscription(ctx, db.ReviveSubscriptionParams{DeviceID: in.Device, IdentityID: in.Person, P256dh: p256dh, Auth: auth, Now: now.UnixMilli(), ID: id})
	case errors.Is(err, sql.ErrNoRows):
		if err := q.DisableDeviceSubscriptions(ctx, db.DisableDeviceSubscriptionsParams{Now: at, Reason: why, DeviceID: in.Device}); err != nil {
			return Subscription{}, err
		}
		id, err = q.InsertSubscription(ctx, db.InsertSubscriptionParams{DeviceID: in.Device, IdentityID: in.Person, Endpoint: in.Endpoint, P256dh: p256dh, Auth: auth, Now: now.UnixMilli()})
	}
	if err != nil {
		return Subscription{}, err
	}
	return Subscription{ID: id, DeviceID: in.Device, Host: HostOf(in.Endpoint), CreatedAt: now.UnixMilli()}, nil
}

// Unsubscribe turns push off for the device.
func Unsubscribe(ctx context.Context, d pdb.DBTX, now time.Time, device int64) error {
	return db.New(d).DisableDeviceSubscriptions(ctx, db.DisableDeviceSubscriptionsParams{
		Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: DisabledUser, Valid: true}, DeviceID: device,
	})
}

// DisableDevice ends the device's subscription because the device was signed out.
func DisableDevice(ctx context.Context, d pdb.DBTX, now time.Time, device int64) error {
	return db.New(d).DisableDeviceSubscriptions(ctx, db.DisableDeviceSubscriptionsParams{
		Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: DisabledDeviceRevoked, Valid: true}, DeviceID: device,
	})
}

// ListSubscriptions returns the person's subscriptions, newest first, live and disabled.
func ListSubscriptions(ctx context.Context, d pdb.DBTX, person int64) ([]Subscription, error) {
	rows, err := db.New(d).ListSubscriptions(ctx, person)
	if err != nil {
		return nil, err
	}
	out := make([]Subscription, len(rows))
	for i, r := range rows {
		out[i] = Subscription{
			ID: r.ID, DeviceID: r.DeviceID, Host: HostOf(r.Endpoint), CreatedAt: r.CreatedAt, LastSuccessAt: r.LastSuccessAt.Int64,
			DisabledAt: r.DisabledAt.Int64, DisabledReason: r.DisabledReason.String,
		}
	}
	return out, nil
}

// live is a subscription that pushes go to, with what the encryption needs.
type live struct {
	ID, Device   int64
	Endpoint     string
	P256dh, Auth []byte
}

func liveOf(ctx context.Context, d pdb.DBTX, person int64) ([]live, error) {
	rows, err := db.New(d).LiveSubscriptions(ctx, person)
	if err != nil {
		return nil, err
	}
	out := make([]live, len(rows))
	for i, r := range rows {
		out[i] = live{ID: r.ID, Device: r.DeviceID, Endpoint: r.Endpoint, P256dh: r.P256dh, Auth: r.Auth}
	}
	return out, nil
}
