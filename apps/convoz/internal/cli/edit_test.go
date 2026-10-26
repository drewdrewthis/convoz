package cli

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// editServer records each PATCH of a message. Message 7 is the agent's own; message 8 is someone else's, refused as the server does.
type editServer struct {
	mu      sync.Mutex
	patches []wire.EditRequest
}

func (e *editServer) handle(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if r.Method != "PATCH" {
		http.NotFound(w, r)
		return
	}
	var in wire.EditRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	switch r.URL.Path {
	case "/api/messages/7":
		e.patches = append(e.patches, in)
		_ = json.NewEncoder(w).Encode(wire.EditResponse{Message: wire.Message{ID: 7, Body: in.Body, EditedAt: 1700000000000}})
	case "/api/messages/8":
		e.patches = append(e.patches, in)
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"Only the author may do that."}}`))
	default:
		http.NotFound(w, r)
	}
}

// An agent edits its own sent message (conv 308 msg 5755): the new text comes as an argument or, with "-", from standard input.
// Each edit carries a client id, so a retry after a lost answer is safe.
func TestEditSendsTheNewTextOfOwnMessage(t *testing.T) {
	var e editServer
	run := agentRunStdin(t, e.handle)

	code, stdout, stderr := run("Build is green\n", Edit, "7", "-")
	if code != ExitOK || stderr != "" {
		t.Fatalf("edit from stdin: exit %d stderr %q", code, stderr)
	}
	if !strings.Contains(stdout, "7") {
		t.Errorf("stdout %q must name the message", stdout)
	}
	code, _, stderr = run("", Edit, "7", "Build is green, really")
	if code != ExitOK || stderr != "" {
		t.Fatalf("edit from an argument: exit %d stderr %q", code, stderr)
	}
	if len(e.patches) != 2 || e.patches[0].Body != "Build is green" || e.patches[1].Body != "Build is green, really" {
		t.Fatalf("patches %+v, want the stdin text (no trailing newline) then the argument", e.patches)
	}
	for _, p := range e.patches {
		if !wire.ValidClientID(p.ClientID) {
			t.Errorf("client id %q is not valid", p.ClientID)
		}
	}
	if e.patches[0].ClientID == e.patches[1].ClientID {
		t.Error("two edits must not share a client id")
	}
}

// Another's message: the server refuses it, and the command exits nonzero with the server's reason.
func TestEditOfAnothersMessageFails(t *testing.T) {
	var e editServer
	run := agentRunStdin(t, e.handle)
	code, _, stderr := run("", Edit, "8", "Hold it")
	if code != ExitAuth || !strings.Contains(stderr, "Only the author") {
		t.Errorf("exit %d stderr %q, want %d and the server's reason", code, stderr, ExitAuth)
	}
}

// A bad call is refused before anything is sent.
func TestEditRefusesABadCallUnsent(t *testing.T) {
	var e editServer
	run := agentRunStdin(t, e.handle)
	for _, c := range []struct {
		stdin string
		args  []string
	}{
		{"", []string{"7"}},
		{"", []string{"seven", "text"}},
		{"", []string{"7", "  "}},
		{"\n", []string{"7", "-"}},
	} {
		if code, _, _ := run(c.stdin, Edit, c.args...); code != ExitUsage {
			t.Errorf("edit %q (stdin %q): exit %d, want %d", c.args, c.stdin, code, ExitUsage)
		}
	}
	if len(e.patches) != 0 {
		t.Errorf("nothing may be sent: %+v", e.patches)
	}
}
