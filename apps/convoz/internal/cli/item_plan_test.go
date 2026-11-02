package cli

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// itemServer answers the item calls as the server does for plans: a key that exists keeps its plan, and a request that names
// another plan is a 409; a request without a plan fits any item; a new key lands in main when no plan is named.
type itemServer struct {
	mu    sync.Mutex
	plans map[string]string // key -> plan of the existing items
	sent  []wire.ItemRequest
}

func (s *itemServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var in wire.ItemRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	s.sent = append(s.sent, in)
	key := r.URL.Path[len("/api/conversations/41/items/") : len(r.URL.Path)-len("/start")]
	have, found := s.plans[key]
	if found && in.Plan != "" && in.Plan != have {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"The item is in another plan."}}`))
		return
	}
	if !found {
		have = in.Plan
		if have == "" {
			have = "main"
		}
	}
	_ = json.NewEncoder(w).Encode(wire.FeedItem{Key: key, Plan: have, State: "started", Title: in.Title})
}

// itemCmd moves the session flag the test helper puts first to after the sub-command, where Item reads it.
func itemCmd(args []string, io IO) int {
	return Item(append([]string{args[2], args[0], args[1]}, args[3:]...), io)
}

// An item made before plans lives in the plan c<conversation>. An agent that edits it with no --plan must not name a plan:
// the default "main" made the server answer 409 (0050 rehearsal).
func TestStartOfAnExistingLegacyItemSendsNoPlan(t *testing.T) {
	s := &itemServer{plans: map[string]string{"old": "c41"}}
	run := agentRunStdin(t, s.handle)

	code, _, stderr := run("", itemCmd, "start", "--context", "Because", "41", "old", "Step")
	if code != ExitOK || stderr != "" {
		t.Fatalf("start with no plan on a c41 item: exit %d stderr %q", code, stderr)
	}
	if s.sent[0].Plan != "" {
		t.Errorf("sent plan %q, want none", s.sent[0].Plan)
	}
}

func TestStartNamingAnotherPlanOfAnExistingItemIsRefused(t *testing.T) {
	s := &itemServer{plans: map[string]string{"old": "c41"}}
	run := agentRunStdin(t, s.handle)

	code, _, _ := run("", itemCmd, "start", "--context", "Because", "--plan", "other", "41", "old", "Step")
	if code == ExitOK {
		t.Fatal("a named plan that differs must fail")
	}
	if s.sent[0].Plan != "other" {
		t.Errorf("sent plan %q, want other", s.sent[0].Plan)
	}
}

func TestStartOfANewItemWithNoPlanLandsInMain(t *testing.T) {
	s := &itemServer{plans: map[string]string{}}
	run := agentRunStdin(t, s.handle)

	code, stdout, stderr := run("", itemCmd, "start", "--context", "Because", "--json", "41", "fresh", "Step")
	if code != ExitOK || stderr != "" {
		t.Fatalf("new item: exit %d stderr %q", code, stderr)
	}
	var out wire.FeedItem
	if err := json.Unmarshal([]byte(stdout), &out); err != nil || out.Plan != "main" {
		t.Errorf("plan %q (%v), want main", out.Plan, err)
	}
}
