package httpapi

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// pushSubject is the VAPID contact: a generic address at the server's own name, not a personal one (design §10.3).
func (s *Server) pushSubject() string { return pushSubjectFor(s.Cfg.Host) }

// pushSubjectFor builds the bare address push@<host>. It carries no "mailto:" (webpush-go adds it, and a second one makes the
// token invalid) and no port (an e-mail domain has none). An IPv6 host becomes a domain literal.
func pushSubjectFor(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return "push@" + host
}

// EnablePush turns the push pipeline on with the keys of the keyring. Without it the push routes answer 503 and nothing is sent.
func (s *Server) EnablePush(keys notify.Keys) {
	s.Push = &notify.Service{
		Store: s.Store, Clock: s.Clock, Keys: keys, Source: pushSource{s}, Client: s.pushClient(), Presence: &notify.Presence{},
		Log: s.Log, Subject: s.pushSubject(),
	}
	if s.Log == nil {
		s.Push.Log = log.Default()
	}
	s.Push.Paused = testPushPaused
}

// pushOff answers 503 when the server was started without push keys (a unit test server).
func (s *Server) pushOff(w http.ResponseWriter) bool {
	if s.Push != nil {
		return false
	}
	writeErr(w, http.StatusServiceUnavailable, "push_off", "Push is not set up on this server.")
	return true
}

// pushVapidKey is GET /api/push/vapid-key.
func (s *Server) pushVapidKey(w http.ResponseWriter, _ *http.Request, _ *call) {
	if s.pushOff(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"public_key": s.Push.Keys.PublicKey()})
}

// subscriptionView is a subscription as the API shows it.
type subscriptionView struct {
	ID             int64  `json:"id"`
	Host           string `json:"host"`
	Current        bool   `json:"current"`
	State          string `json:"state"`
	DisabledReason string `json:"disabled_reason,omitempty"`
	CreatedAt      int64  `json:"created_at"`
	LastSuccessAt  int64  `json:"last_success_at,omitempty"`
}

func viewOfSubscription(sub notify.Subscription, device int64) subscriptionView {
	v := subscriptionView{ID: sub.ID, Host: sub.Host, Current: sub.DeviceID == device, State: "active", CreatedAt: sub.CreatedAt, LastSuccessAt: sub.LastSuccessAt}
	if !sub.Active() {
		v.State, v.DisabledReason = "disabled", sub.DisabledReason
	}
	return v
}

// pushList is GET /api/push/subscriptions: the owner's subscriptions, a gone one listed as disabled.
func (s *Server) pushList(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pushOff(w) {
		return
	}
	subs, err := notify.ListSubscriptions(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]subscriptionView, len(subs))
	for i, sub := range subs {
		out[i] = viewOfSubscription(sub, c.dev.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscriptions": out})
}

// pushSubscribe is POST /api/push/subscriptions {endpoint, keys:{p256dh, auth}}.
func (s *Server) pushSubscribe(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pushOff(w) {
		return
	}
	var in struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
		Messages bool `json:"messages"`
	}
	if !decode(w, r, &in) {
		return
	}
	var sub notify.Subscription
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		sub, err = notify.Subscribe(ctx, tx.DBTX(), s.Clock.Now(), notify.NewSubscription{
			Device: c.dev.ID, Person: c.human.ID, Endpoint: in.Endpoint, P256dh: in.Keys.P256dh, Auth: in.Keys.Auth, Messages: in.Messages,
		})
		return err
	})
	switch {
	case errors.Is(err, notify.ErrBadEndpoint):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "endpoint", err.Error())
	case errors.Is(err, notify.ErrBadKeys):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "keys", err.Error())
	case err != nil:
		s.internalError(w, r, err)
	default:
		// The host of the push service only: the endpoint path is a secret that lets anyone push to this device.
		s.Push.Log.Printf("push: subscribed device=%d person=%d host=%s", c.dev.ID, c.human.ID, sub.Host)
		writeJSON(w, http.StatusCreated, map[string]any{"subscription": viewOfSubscription(sub, c.dev.ID)})
	}
}

// pushUnsubscribe is DELETE /api/push/subscriptions: push off for this device.
func (s *Server) pushUnsubscribe(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pushOff(w) {
		return
	}
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		return notify.Unsubscribe(ctx, tx.DBTX(), s.Clock.Now(), c.dev.ID)
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pushTest is POST /api/push/test: one test push to this device now.
func (s *Server) pushTest(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pushOff(w) {
		return
	}
	delivered, err := s.Push.SendTest(r.Context(), c.dev.ID)
	s.Push.Log.Printf("push: test device=%d delivered=%t err=%v", c.dev.ID, delivered, err)
	switch {
	case errors.Is(err, notify.ErrNoSubscription):
		writeErr(w, http.StatusConflict, "no_subscription", "Turn push on for this device first.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"delivered": delivered})
	}
}

// pushFocus is PUT /api/push/focus {conversation_id}: where this device looks, so a push for it is held back (active_here).
func (s *Server) pushFocus(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pushOff(w) {
		return
	}
	var in struct {
		ConversationID int64 `json:"conversation_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.Push.Presence.Set(c.dev.ID, in.ConversationID, s.Clock.Now())
	w.WriteHeader(http.StatusNoContent)
}

// pushClient is the HTTP client that posts to push services: no redirects (an endpoint is allow-listed, a redirect target is not) and a time limit.
func (s *Server) pushClient() notify.HTTPClient {
	if testPushClient != nil {
		return testPushClient()
	}
	return &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// The test build sets these: its fake push service, and a hold that keeps the sender from sending.
var (
	testPushClient func() notify.HTTPClient
	testPushPaused func() bool
)
