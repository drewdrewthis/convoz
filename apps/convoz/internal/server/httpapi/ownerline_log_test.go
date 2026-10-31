package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Ops counts rejected owner lines by agent and field; the text may be private, so the line never carries it.

func loggedRig(t *testing.T) (*freshRig, *lockedLog) {
	t.Helper()
	r := newFreshRig(t)
	sink := &lockedLog{}
	r.s.Log = log.New(sink, "", 0)
	return r, sink
}

func wantRejection(t *testing.T, r *freshRig, out, field, text string) {
	t.Helper()
	for _, want := range []string{`msg="owner line rejected"`, "agent=alpha", "field=" + field, "conv=" + strconv.FormatInt(r.conv, 10), "why="} {
		if !strings.Contains(out, want) {
			t.Errorf("log %q lacks %q", out, want)
		}
	}
	if strings.Contains(out, text) {
		t.Errorf("log %q carries the text", out)
	}
}

func TestARejectedPlanWaitIsLoggedWithAgentFieldAndConvButNotTheText(t *testing.T) {
	r, sink := loggedRig(t)
	if code, _ := r.putWaiting(t, "Approve it"); code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", code)
	}
	wantRejection(t, r, sink.String(), "waiting", "Approve it")
}

func TestARejectedAskQuestionIsLoggedWithAgentAndField(t *testing.T) {
	r, sink := loggedRig(t)
	if code, _ := r.postQuestion(t, "Merge it"); code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", code)
	}
	wantRejection(t, r, sink.String(), "question", "Merge it")
}

func TestARejectedBlockTitleIsLoggedWithFieldAndConv(t *testing.T) {
	r, sink := loggedRig(t)
	if code, _, _ := r.block(t, "k1", "Approve it"); code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", code)
	}
	wantRejection(t, r, sink.String(), "title", "Approve it")
}

func TestAPermissionAskWithAShortQuestionLogsNothing(t *testing.T) {
	r, sink := loggedRig(t)
	b, _ := json.Marshal(wire.AskRequest{ConversationID: r.conv, ClientID: "client-perm", Question: "Merge it",
		Permission: &wire.AskPermission{Action: "Merge the PR", Risk: "A bad merge", Undo: "Revert it", Considered: []string{"Wait: slower"}, Confidence: 100}})
	code, e := r.send(t, r.s.postAsk, "POST", string(b), nil)
	if code != http.StatusCreated {
		t.Fatalf("%d %+v, want 201", code, e)
	}
	if strings.Contains(sink.String(), "owner line rejected") {
		t.Errorf("log %q has a rejection for a permission ask", sink.String())
	}
}
