package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
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
