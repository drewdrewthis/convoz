package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

const sendFailed = `{"event":"send_failed"}`

func TestClientEventSendFailedIsAcceptedWithNoContent(t *testing.T) {
	rig := newTelRig(t, nil)
	if rec := rig.do("POST", "/api/client-events", sendFailed, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204 (%s)", rec.Code, rec.Body.String())
	}
}

func TestClientEventIgnoresEveryOtherField(t *testing.T) {
	rig := newTelRig(t, nil)
	rec := rig.do("POST", "/api/client-events", `{"event":"send_failed","message":"anything","stack":"x","page":"/chats"}`, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
}

func TestClientEventRefusesWhatItDoesNotKnow(t *testing.T) {
	rig := newTelRig(t, nil)
	for name, body := range map[string]string{
		"an unknown event":   `{"event":"page_loaded"}`,
		"an empty event":     `{"event":""}`,
		"no event":           `{}`,
		"an event with case": `{"event":"Send_Failed"}`,
		"not JSON":           `send_failed`,
		"a body over 1 KB":   `{"event":"send_failed","pad":"` + strings.Repeat("x", 1100) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if rec := rig.do("POST", "/api/client-events", body, nil); rec.Code != http.StatusBadRequest {
				t.Errorf("status %d, want 400", rec.Code)
			}
		})
	}
}

func TestClientEventNeedsTheOwnersDeviceSession(t *testing.T) {
	rig := newTelRig(t, nil)
	t.Run("an anonymous caller is refused", func(t *testing.T) {
		if rec := rig.send("", "POST", "/api/client-events", sendFailed, nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("status %d, want 401", rec.Code)
		}
	})
	t.Run("an agent credential is refused", func(t *testing.T) {
		rec := rig.send("", "POST", "/api/client-events", sendFailed, map[string]string{"Authorization": "Bearer cvz_s_TESTONLYnotalease"})
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status %d, want 401", rec.Code)
		}
	})
}

func TestClientEventRouteIsTheOwnersAndNotTheAgentPorts(t *testing.T) {
	for _, rt := range Routes {
		if rt.Pattern != "/api/client-events" {
			continue
		}
		if _, served := rt.AgentReason(); served || rt.Auth != authz.Owner || rt.Lease || rt.Method != http.MethodPost {
			t.Errorf("route %+v: want POST, owner only, no lease, not on the agent listener", rt)
		}
		return
	}
	t.Error("no route for /api/client-events")
}

func TestClientEventIsLimitedPerDeviceSession(t *testing.T) {
	rig := newTelRig(t, nil)
	for i := 0; i < clientEventsPerHour; i++ {
		if rec := rig.do("POST", "/api/client-events", sendFailed, nil); rec.Code != http.StatusNoContent {
			t.Fatalf("event %d: %d", i+1, rec.Code)
		}
	}
	rec := rig.do("POST", "/api/client-events", sendFailed, nil)
	t.Run("the next event is 429", func(t *testing.T) {
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("status %d, want 429", rec.Code)
		}
	})
	t.Run("the 429 carries Retry-After", func(t *testing.T) {
		if rec.Header().Get("Retry-After") == "" {
			t.Error("no Retry-After")
		}
	})
}

// mintAgentLease gives the rig a real machine and a real agent session, the way a box signs in, and returns its bearer lease.
func (r *telRig) mintAgentLease(t *testing.T) string {
	t.Helper()
	var lease string
	err := r.store.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		d, now := tx.DBTX(), time.Now()
		box, err := auth.NewKeyBox(bytes.Repeat([]byte{7}, 32))
		if err != nil {
			return err
		}
		machine, err := auth.CreateMachine(ctx, d, box, auth.NewMachine{Name: "box-1", Scopes: auth.DefaultScopes | auth.ScopeCreateIdentity, Allow: auth.Allow{Mode: auth.AllowAny}, ApprovedBy: r.owner}, now)
		if err != nil {
			return err
		}
		key, err := auth.RevealKey(ctx, d, box, machine)
		if err != nil {
			return err
		}
		minted, err := auth.MintSession(ctx, d, flowPorts, auth.MintRequest{MachineKey: key, As: "alpha", ClientID: "client-001", Create: &auth.CreateIdentity{DisplayName: "Alpha"}}, now)
		lease = minted.Lease
		return err
	})
	if err != nil || lease == "" {
		t.Fatalf("mint an agent lease: %v (lease %q)", err, lease)
	}
	return lease
}

func TestClientEventRefusesARealAgentSession(t *testing.T) {
	rcv := newReceiver(t)
	tel := startTelemetry(t, rcv)
	rig := newTelRig(t, tel)
	bearer := map[string]string{"Authorization": "Bearer " + rig.mintAgentLease(t)}

	if rec := rig.send("", "GET", "/api/me", "", bearer); rec.Code != http.StatusOK {
		t.Fatalf("the lease is not valid: GET /api/me gave %d (%s)", rec.Code, rec.Body.String())
	}
	rec := rig.send("", "POST", "/api/client-events", sendFailed, bearer)
	flush(t, tel)

	t.Run("the real lease is refused with 401 or 403", func(t *testing.T) {
		if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
			t.Errorf("status %d, want 401 or 403", rec.Code)
		}
	})
	t.Run("the send_failures counter stays uncounted", func(t *testing.T) {
		if got, ok := rcv.counter("convoz.web.send_failures", nil); ok && got != 0 {
			t.Errorf("convoz.web.send_failures = %d, want none", got)
		}
	})
}

func TestClientEventIsNotOnTheAgentListenerForARealAgentSession(t *testing.T) {
	rig := newTelRig(t, nil)
	rig.s.Cfg.AgentHost, rig.s.Cfg.AgentPort, rig.s.Cfg.AgentOrigin = testAgentHost, 45123, "https://"+testAgentHost
	h := rig.s.AgentHandler()
	lease := rig.mintAgentLease(t)

	me := viaFunnel("GET", "/api/me", "203.0.113.40", "")
	me.Header.Set("Authorization", "Bearer "+lease)
	if got := serve(h, me).Code; got != http.StatusOK {
		t.Fatalf("the lease is not valid on the agent listener: GET /api/me gave %d", got)
	}
	req := viaFunnel("POST", "/api/client-events", "203.0.113.40", sendFailed)
	req.Header.Set("Authorization", "Bearer "+lease)
	for k, v := range writeHeaders {
		req.Header.Set(k, v)
	}
	if got := serve(h, req).Code; got != http.StatusNotFound {
		t.Errorf("status %d, want 404", got)
	}
}
