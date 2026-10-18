package notify

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Delivery limits and timings (design §10.3 "headers, retries, cleanup").
const (
	maxAttempts    = 4                // a delivery is tried this often, then it is failed
	failuresToStop = 5                // failed deliveries in a row after which the subscription is disabled
	sendTimeout    = 15 * time.Second // one POST to the push service
	maxRetryAfter  = time.Hour
	dueBatch       = 50
	burstWindow    = time.Minute
)

// retryDelay is the wait after the nth failed attempt (1-based).
var retryDelay = [maxAttempts]time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}

// ttlSeconds is how long the push service keeps a push for a device that is offline. A machine request is stale after its 10 minutes.
func ttlSeconds(reason string) int {
	if reason == ReasonMachineRequest {
		return 600
	}
	return int(expiry / time.Second)
}

// post encrypts the payload for the subscription (RFC 8291, by webpush-go), pads it to the next 512-byte bucket and posts it.
func (s *Service) post(ctx context.Context, endpoint string, p256dh, auth []byte, p Payload, urgent bool, ttl int) (status int, retryAfter time.Duration, err error) {
	body, record, err := p.encode()
	if err != nil {
		return 0, 0, err
	}
	urgency := webpush.UrgencyNormal
	if urgent {
		urgency = webpush.UrgencyHigh
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	resp, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{
		Endpoint: endpoint,
		Keys:     webpush.Keys{Auth: base64.RawURLEncoding.EncodeToString(auth), P256dh: base64.RawURLEncoding.EncodeToString(p256dh)},
	}, &webpush.Options{
		HTTPClient: s.Client, RecordSize: record, Subscriber: s.Subject, Topic: p.Topic, TTL: ttl, Urgency: urgency,
		VAPIDPublicKey: s.Keys.vapidPublic, VAPIDPrivateKey: s.Keys.vapidPrivate,
	})
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if secs, perr := strconv.Atoi(resp.Header.Get("Retry-After")); perr == nil && secs > 0 {
		retryAfter = min(time.Duration(secs)*time.Second, maxRetryAfter)
	}
	return resp.StatusCode, retryAfter, nil
}

// SendDue sends the deliveries that are due and returns how many it handled. Before each it checks again that the person can
// still see what it is about and that the device is still signed in (I-28): a push is built from what is true at send time.
func (s *Service) SendDue(ctx context.Context) (int, error) {
	if s.Paused != nil && s.Paused() {
		return 0, nil
	}
	now := s.Clock.Now()
	rd := s.Store.Reader.SQL()
	due, err := db.New(rd).DueDeliveries(ctx, db.DueDeliveriesParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, MaxRows: dueBatch})
	if err != nil {
		return 0, err
	}
	for _, row := range due {
		if err := s.sendOne(ctx, rd, row); err != nil {
			return 0, err
		}
	}
	return len(due), nil
}

func (s *Service) sendOne(ctx context.Context, rd pdb.DBTX, row db.DueDeliveriesRow) error {
	now := s.Clock.Now()
	n := Notification{
		ID: row.NotificationID, Person: row.IdentityID, SourceSeq: row.SourceSeq, Conversation: row.ConversationID.Int64, Message: row.MessageID.Int64,
		Reason: row.Reason, Topic: row.Topic, Urgent: row.Urgent == 1, CreatedAt: row.NotifiedAt,
	}
	alive, err := s.Source.DeviceLive(ctx, rd, row.DeviceID)
	if err != nil {
		return err
	}
	switch {
	case !alive:
		return s.write(ctx, func(q *db.Queries) error {
			return endSubscription(ctx, q, now, row.SubscriptionID, DisabledDeviceRevoked)
		})
	case now.Sub(time.UnixMilli(row.NotifiedAt)) > expiry:
		return s.write(ctx, func(q *db.Queries) error {
			if err := q.ExpireNotification(ctx, n.ID); err != nil {
				return err
			}
			return q.DropPendingDeliveries(ctx, n.ID)
		})
	case !AllowedEndpoint(row.Endpoint):
		return s.write(ctx, func(q *db.Queries) error { return endSubscription(ctx, q, now, row.SubscriptionID, DisabledGone) })
	}
	facts, err := s.Source.Facts(ctx, rd, n)
	if err != nil {
		return err
	}
	if !facts.Visible {
		return s.write(ctx, func(q *db.Queries) error {
			if err := q.SuppressNotification(ctx, db.SuppressNotificationParams{Why: sql.NullString{String: WhyNotVisible, Valid: true}, ID: n.ID}); err != nil {
				return err
			}
			return q.DropPendingDeliveries(ctx, n.ID)
		})
	}
	burst, err := db.New(rd).BurstSize(ctx, db.BurstSizeParams{IdentityID: n.Person, Topic: n.Topic, ID: n.ID, Since: n.CreatedAt - burstWindow.Milliseconds()})
	if err != nil {
		return err
	}
	status, retryAfter, err := s.post(ctx, row.Endpoint, row.P256dh, row.Auth, Compose(n.Reason, n.Topic, facts, int(burst)), n.Urgent, ttlSeconds(n.Reason))
	if ctx.Err() != nil {
		return ctx.Err() // shutting down: the delivery stays due and the next run sends it
	}
	if err != nil {
		status = 0 // the push service could not be reached: like a 5xx, try again later
	}
	return s.write(ctx, func(q *db.Queries) error { return s.settle(ctx, q, now, row, status, retryAfter) })
}

// settle records what the push service answered: sent, gone (the subscription ends), retry later, or failed.
func (s *Service) settle(ctx context.Context, q *db.Queries, now time.Time, row db.DueDeliveriesRow, status int, retryAfter time.Duration) error {
	at := sql.NullInt64{Int64: now.UnixMilli(), Valid: true}
	code := sql.NullInt64{Int64: int64(status), Valid: status != 0}
	finish := func(state string, attempt int64, next sql.NullInt64) error {
		return q.FinishDelivery(ctx, db.FinishDeliveryParams{Status: state, Attempt: attempt, HttpStatus: code, NextAttemptAt: next, Now: now.UnixMilli(), ID: row.ID})
	}
	switch {
	case status >= 200 && status < 300:
		if err := finish("sent", row.Attempt, sql.NullInt64{}); err != nil {
			return err
		}
		return q.SubscriptionSucceeded(ctx, db.SubscriptionSucceededParams{Now: at, ID: row.SubscriptionID})
	case status == http.StatusNotFound || status == http.StatusGone:
		if err := finish("gone", row.Attempt, sql.NullInt64{}); err != nil {
			return err
		}
		return endSubscription(ctx, q, now, row.SubscriptionID, DisabledGone)
	case status == 0 || status == 429 || status >= 500:
		if row.Attempt < maxAttempts {
			wait := max(retryDelay[row.Attempt-1], retryAfter)
			return finish("retry", row.Attempt+1, sql.NullInt64{Int64: now.Add(wait).UnixMilli(), Valid: true})
		}
	}
	// A 4xx the service will not change its mind about, or the last attempt.
	if err := finish("failed", row.Attempt, sql.NullInt64{}); err != nil {
		return err
	}
	failures, err := q.SubscriptionFailed(ctx, row.SubscriptionID)
	if err != nil || failures < failuresToStop {
		return err
	}
	return endSubscription(ctx, q, now, row.SubscriptionID, DisabledFailures)
}

// endSubscription disables a subscription and drops its deliveries that wait.
func endSubscription(ctx context.Context, q *db.Queries, now time.Time, id int64, reason string) error {
	if err := q.DisableSubscription(ctx, db.DisableSubscriptionParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Reason: sql.NullString{String: reason, Valid: true}, ID: id}); err != nil {
		return err
	}
	return q.DropSubscriptionDeliveries(ctx, id)
}

func (s *Service) write(ctx context.Context, fn func(q *db.Queries) error) error {
	return s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error { return fn(db.New(tx.DBTX())) })
}

// ErrNoSubscription means the device has no live subscription to test.
var ErrNoSubscription = errors.New("this device has no live push subscription")

// SendTest sends a test push to the device now, once, and says whether the push service took it.
func (s *Service) SendTest(ctx context.Context, device int64) (bool, error) {
	sub, err := db.New(s.Store.Reader.SQL()).LiveSubscriptionOfDevice(ctx, device)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNoSubscription
	}
	if err != nil {
		return false, err
	}
	p := Payload{V: 1, Reason: "test", Title: "Notifications are on", Body: "You'll get messages from your agents here.", URL: "/settings", Topic: s.Keys.Topic('z', device)}
	status, _, err := s.post(ctx, sub.Endpoint, sub.P256dh, sub.Auth, p, false, 60)
	if err != nil {
		return false, nil //nolint:nilerr // the push service could not be reached: not delivered, and not a server fault
	}
	if status == http.StatusNotFound || status == http.StatusGone {
		_ = s.write(ctx, func(q *db.Queries) error { return endSubscription(ctx, q, s.Clock.Now(), sub.ID, DisabledGone) })
	}
	return status >= 200 && status < 300, nil
}

// Run consumes events and sends pushes until ctx ends. changed returns the channel that closes at the next commit; it is taken before
// each pass, so a commit during the pass wakes the next one. A pass also runs every second, for retries that come due.
func (s *Service) Run(ctx context.Context, changed func() <-chan struct{}) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		wake := changed()
		for more := true; more && ctx.Err() == nil; {
			var err error
			if more, err = s.Consume(ctx); err != nil && ctx.Err() == nil {
				s.Log.Printf("push: consume: %v", err)
				more = false
			}
		}
		for n := dueBatch; n == dueBatch && ctx.Err() == nil; {
			var err error
			if n, err = s.SendDue(ctx); err != nil && ctx.Err() == nil {
				s.Log.Printf("push: send: %v", err)
				n = 0
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-wake:
		}
	}
}
