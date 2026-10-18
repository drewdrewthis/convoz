package httpapi

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// testInvites makes n invites, spread over as many makers as the caps need (ten for the owner, three for an agent). The owner is the first maker.
func testInvites(t *testing.T, s *Server, n int) []string {
	t.Helper()
	var tokens []string
	dbtest.Tx(t, s.Store, func(ctx context.Context, d pdb.DBTX) error {
		now := s.Clock.Now()
		owner, err := identity.CreateOwner(ctx, d, "drew", "Drew", now)
		if err != nil {
			return err
		}
		maker, held := owner.ID, 0
		for i := 0; i < n; i++ {
			limit := auth.MaxOpenInvites
			if maker != owner.ID {
				limit = auth.MaxOpenAgentInvites
			}
			if held == limit {
				a, err := identity.CreateAgent(ctx, d, identity.NewAgent{Handle: fmt.Sprintf("maker-%d", i), DisplayName: fmt.Sprintf("Maker number %d", i), ByHuman: owner.ID}, now)
				if err != nil {
					return err
				}
				maker, held = a.ID, 0
			}
			_, token, err := auth.CreateInvite(ctx, d, flowPorts, auth.NewInvite{By: auth.AuditEntry{Actor: maker}}, now)
			if err != nil {
				return err
			}
			held++
			tokens = append(tokens, token)
		}
		return nil
	})
	return tokens
}

func openInvites(t *testing.T, s *Server) int {
	t.Helper()
	list, err := auth.OpenInvites(context.Background(), s.reader(), 0, s.Clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	return len(list)
}

func pendingCount(t *testing.T, s *Server) int {
	t.Helper()
	list, err := auth.PendingRequests(context.Background(), s.reader(), s.Clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	return len(list)
}

func denyAll(t *testing.T, s *Server) {
	t.Helper()
	dbtest.Tx(t, s.Store, func(ctx context.Context, d pdb.DBTX) error {
		owner, err := identity.Owner(ctx, d)
		if err != nil {
			return err
		}
		_, err = auth.DenyAllRequests(ctx, d, owner.ID, s.Clock.Now())
		return err
	})
}

// stepClock is a clock a test moves by hand.
type stepClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *stepClock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.at }
func (c *stepClock) add(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.at = c.at.Add(d) }

func steppedAPI(t *testing.T) (*Server, *stepClock) {
	t.Helper()
	clock := &stepClock{at: time.Now()}
	cfg := Config{Host: "convoz.testonly.ts.net", Version: "test", AgentHost: testAgentHost, AgentPort: 45123, AgentOrigin: "https://" + testAgentHost}
	return NewServer(dbtest.Store(t), clock, nil, nil, cfg, log.New(io.Discard, "", 0)), clock
}

func auditActions(t *testing.T, s *Server) []string {
	t.Helper()
	rows, err := audit.List(context.Background(), s.reader(), 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, r := range rows {
		out = append(out, r.Action)
	}
	return out
}

// Owner ruling (2026-10-18): a request over the internet needs an invite, and an invite works once. Without a usable one the answer is
// the same as for an accepted request, but nothing is made.
func TestADeviceStartOverTheInternetSpendsOneInvite(t *testing.T) {
	s := agentTestAPI(t)
	h := s.AgentHandler()
	invite := testInvites(t, s, 1)[0]

	none := startDevice(h, "203.0.113.1", deviceBody("box-1", "dot", ""))
	if none.Code != http.StatusOK || !strings.Contains(none.Body.String(), `"user_code"`) {
		t.Fatalf("no invite: got %d %s, want the answer of an accepted request", none.Code, none.Body.String())
	}
	if n := pendingCount(t, s); n != 0 {
		t.Fatalf("no invite made %d requests", n)
	}

	if got := startDevice(h, "203.0.113.1", deviceBody("box-1", "dot", invite)).Code; got != http.StatusOK || pendingCount(t, s) != 1 {
		t.Fatalf("with the invite: got %d, %d requests", got, pendingCount(t, s))
	}
	again := startDevice(h, "203.0.113.2", deviceBody("box-2", "cat", invite))
	if again.Code != http.StatusOK || pendingCount(t, s) != 1 {
		t.Fatalf("the invite twice: got %d, %d requests, want 200 and still 1", again.Code, pendingCount(t, s))
	}
	if n := openInvites(t, s); n != 0 {
		t.Fatalf("%d invites are open after the only one was used", n)
	}
	if got := strings.Join(auditActions(t, s), " "); !strings.Contains(got, "invite.created") || !strings.Contains(got, "invite.used") {
		t.Fatalf("audit = %q", got)
	}
}

func TestADeviceStartOnTheTailnetNeedsNoInvite(t *testing.T) {
	s := agentTestAPI(t)
	req := httptest.NewRequest("POST", "/api/device/code", strings.NewReader(deviceBody("box-1", "", "")))
	req.Host, req.RemoteAddr = "convoz.testonly.ts.net", "127.0.0.1:4000"
	rec := serve(s.Handler(), req)
	if rec.Code != http.StatusOK || pendingCount(t, s) != 1 {
		t.Fatalf("got %d, %d requests", rec.Code, pendingCount(t, s))
	}
}

func TestAnInviteThatRanOutMakesNoRequestAndIsAudited(t *testing.T) {
	s, clock := steppedAPI(t)
	h := s.AgentHandler()
	invite := testInvites(t, s, 1)[0]
	clock.add(auth.InviteTTL + time.Minute)
	if got := startDevice(h, "203.0.113.1", deviceBody("box-1", "", invite)).Code; got != http.StatusOK || pendingCount(t, s) != 0 {
		t.Fatalf("got %d, %d requests", got, pendingCount(t, s))
	}
	if !strings.Contains(strings.Join(auditActions(t, s), " "), "invite.expired") {
		t.Fatalf("audit = %v", auditActions(t, s))
	}
}

func TestARevokedInviteMakesNoRequest(t *testing.T) {
	s := agentTestAPI(t)
	h := s.AgentHandler()
	invite := testInvites(t, s, 1)[0]
	dbtest.Tx(t, s.Store, func(ctx context.Context, d pdb.DBTX) error {
		list, err := auth.OpenInvites(ctx, d, 0, s.Clock.Now())
		if err != nil || len(list) != 1 {
			return fmt.Errorf("%d invites, %v", len(list), err)
		}
		return auth.RevokeInvite(ctx, d, flowPorts, list[0].ID, auth.AuditEntry{Actor: list[0].MakerID}, true, s.Clock.Now())
	})
	if got := startDevice(h, "203.0.113.1", deviceBody("box-1", "", invite)).Code; got != http.StatusOK || pendingCount(t, s) != 0 {
		t.Fatalf("got %d, %d requests", got, pendingCount(t, s))
	}
}

func TestAMakerHoldsTenOpenInvites(t *testing.T) {
	s := agentTestAPI(t)
	testInvites(t, s, auth.MaxOpenInvites)
	err := dbtest.TxErr(t, s.Store, func(ctx context.Context, d pdb.DBTX) error {
		owner, err := identity.Owner(ctx, d)
		if err != nil {
			return err
		}
		_, _, err = auth.CreateInvite(ctx, d, flowPorts, auth.NewInvite{By: auth.AuditEntry{Actor: owner.ID}}, s.Clock.Now())
		return err
	})
	if err != auth.ErrInviteCap {
		t.Fatalf("the 11th invite: %v", err)
	}
}
