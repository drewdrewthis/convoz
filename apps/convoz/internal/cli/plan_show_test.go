package cli

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// planServer answers GET and PUT of /api/conversations/41/plan and records what it was asked.
type planServer struct {
	mu      sync.Mutex
	methods []string
	put     wire.PlanRequest
}

func (s *planServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.methods = append(s.methods, r.Method)
	if r.Method == http.MethodPut {
		_ = json.NewDecoder(r.Body).Decode(&s.put)
		_ = json.NewEncoder(w).Encode(wire.Plan{Now: []wire.PlanNow{}, Next: []string{}})
		return
	}
	_ = json.NewEncoder(w).Encode(wire.PlanList{Plans: []wire.Plan{
		{Handle: "devtool", Now: []wire.PlanNow{{Text: "Building invites", Step: &wire.PlanStep{At: 2, Of: 3}}}, Doing: "Building invites",
			Next: []string{"Reply chip"}, Blocked: "CI is red", Waiting: []wire.PlanWaiting{{Text: "Approve the card"}},
			Deliver: []wire.PlanDeliver{{Text: "Search filters live", Due: 1893456000000}}, Done: []wire.PlanDone{{Text: "Setup"}}},
		{Handle: "docs", Now: []wire.PlanNow{{Text: "Writing docs"}}, Doing: "Writing docs", Next: []string{}},
	}})
}

func (s *planServer) wrote() bool {
	for _, m := range s.methods {
		if m != http.MethodGet {
			return true
		}
	}
	return false
}

func TestPlanShowPrintsTheCallersOwnPlanAndNeverWrites(t *testing.T) {
	s := &planServer{}
	run := agentRunStdin(t, s.handle) // the session is "devtool"

	code, out, stderr := run("", Plan, "41", "--show")
	if code != ExitOK || stderr != "" {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	for _, want := range []string{"Doing: Building invites (step 2 of 3)", "Next: Reply chip", "Blocked: CI is red", "Waiting on you: Approve the card", "Search filters live", "Done: Setup"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Writing docs") {
		t.Errorf("another agent's plan shown:\n%s", out)
	}
	if s.wrote() {
		t.Errorf("--show sent %v, want GET only", s.methods)
	}
}

func TestPlanShowAgentPicksAnotherPlanAndJSONPrintsOnePlan(t *testing.T) {
	s := &planServer{}
	run := agentRunStdin(t, s.handle)

	code, out, _ := run("", Plan, "41", "--show", "--agent", "@docs", "--json")
	var got wire.Plan
	if code != ExitOK || json.Unmarshal([]byte(out), &got) != nil || got.Handle != "docs" {
		t.Fatalf("exit %d, out %q", code, out)
	}
	if code, out, _ := run("", Plan, "41", "--show", "--agent", "nobody"); code != ExitOK || !strings.Contains(out, "Nothing planned") {
		t.Errorf("an agent with no plan: exit %d out %q", code, out)
	}
	if s.wrote() {
		t.Errorf("sent %v, want GET only", s.methods)
	}
}

func TestPlanShowWithItemFlagsIsRefused(t *testing.T) {
	s := &planServer{}
	run := agentRunStdin(t, s.handle)
	code, _, stderr := run("", Plan, "41", "--show", "--doing", "X")
	if code != ExitUsage || !strings.Contains(stderr, "--show") || len(s.methods) != 0 {
		t.Errorf("exit %d stderr %q calls %v", code, stderr, s.methods)
	}
}

func TestBarePlanRefusesAndWritesNothing(t *testing.T) {
	s := &planServer{}
	run := agentRunStdin(t, s.handle)
	for _, args := range [][]string{{"41"}, {"41", "--json"}} {
		code, _, stderr := run("", Plan, args...)
		if code != ExitUsage || !strings.Contains(stderr, "--show") || !strings.Contains(stderr, "--clear") {
			t.Errorf("%v: exit %d stderr %q", args, code, stderr)
		}
	}
	if len(s.methods) != 0 {
		t.Errorf("a bare plan called the server: %v", s.methods)
	}
}

func TestPlanClearReplacesThePlanWithNothing(t *testing.T) {
	s := &planServer{}
	run := agentRunStdin(t, s.handle)
	code, _, stderr := run("", Plan, "41", "--clear")
	if code != ExitOK || stderr != "" || len(s.methods) != 1 || s.methods[0] != http.MethodPut || s.put.Doing != "" || len(s.put.Next) != 0 {
		t.Errorf("exit %d stderr %q calls %v put %+v", code, stderr, s.methods, s.put)
	}
	if code, _, stderr := run("", Plan, "41", "--clear", "--doing", "X"); code != ExitUsage || !strings.Contains(stderr, "--clear") {
		t.Errorf("--clear with items: exit %d stderr %q", code, stderr)
	}
}
