package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Each poll of the watch sends back the cursor of the last answer it got, so the server can resend every claim of the session made
// since: one whose answer was lost on the way, and one another loop of the same session made (prod, 2026-10-19).
func TestWatchSendsTheCursorOfTheLastAnswerWithEachPoll(t *testing.T) {
	var afters []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != wire.RouteInbox {
			http.NotFound(w, r)
			return
		}
		afters = append(afters, r.URL.Query().Get("after"))
		w.Header().Set("Content-Type", "application/json")
		if len(afters) == 1 {
			_ = json.NewEncoder(w).Encode(wire.InboxResponse{Items: []wire.InboxItem{{ID: 9, ClaimToken: "00112233445566778899aabbccddeeff", Reason: "activity"}}, Cursor: 7})
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(wire.Error{Error: wire.ErrorDetail{Code: wire.CodeSessionEnded, Message: "The session ended."}})
	}))
	defer srv.Close()

	xdg := t.TempDir()
	dir := filepath.Join(xdg, "convoz")
	if err := saveCredentials(dir, brokenKeychain{}, Credentials{Server: srv.URL, Machine: "box-2", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	sid, err := saveSession(dir, sessionFile{Lease: "cvz_s_TESTONLYlease", Identity: "devtool", Machine: "box-2", ClientID: "claude-1234"})
	if err != nil {
		t.Fatal(err)
	}
	env := func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}
	var stdout, stderr bytes.Buffer
	if code := Watch([]string{"--json", "--sid", sid}, IO{Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr, Getenv: env}); code != ExitAuth {
		t.Fatalf("watch: exit %d, want 3 when the session ends: %s", code, stderr.String())
	}
	if strings.Join(afters, ",") != "0,7" {
		t.Errorf("after= of each poll: %q, want the first poll from 0 and the next from the cursor 7", afters)
	}
	if strings.Count(stdout.String(), "\n") != 1 {
		t.Errorf("one line for the one item: %q", stdout.String())
	}
}
