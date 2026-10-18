package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// A command that opens the session file only after `convoz session end` ran (a watch started a moment before the
// end, on a busy machine) must still say the session ended, not that there never was one. The order is forced:
// end first, then watch.
func TestWatchThatOpensAnEndedSessionSaysTheSessionEnded(t *testing.T) {
	var other atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.Path == wire.RouteSessionsMe {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		other.Add(1)
		http.NotFound(w, r)
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
	run := func(cmd func([]string, IO) int, args ...string) (int, string) {
		var stderr bytes.Buffer
		code := cmd(args, IO{Stdin: strings.NewReader(""), Stdout: &bytes.Buffer{}, Stderr: &stderr, Getenv: env})
		return code, stderr.String()
	}

	if code, stderr := run(SessionEnd, "--sid", sid); code != ExitOK {
		t.Fatalf("session end: exit %d: %s", code, stderr)
	}
	code, stderr := run(Watch, "--json", "--sid", sid)
	if code != ExitAuth || !strings.Contains(strings.ToLower(stderr), "session ended") {
		t.Errorf("watch after session end: exit %d, stderr %q; want exit 3 saying the session ended", code, stderr)
	}
	if n := other.Load(); n != 0 {
		t.Errorf("the ended session needs no server call to know it ended; got %d", n)
	}
	if code, stderr := run(SessionEnd, "--sid", sid); code != ExitOK {
		t.Errorf("ending an ended session again: exit %d: %s", code, stderr)
	}
	if code, _ := run(Whoami, "--sid", sid); code != ExitAuth {
		t.Errorf("whoami after session end: exit %d, want 3", code)
	}
}

// The marker an ended session leaves holds no lease, and a new session of the same client id clears it.
func TestAnEndedSessionKeepsNoLeaseAndIsForgottenOnReplace(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "convoz")
	sid, err := saveSession(dir, sessionFile{Lease: "cvz_s_TESTONLYlease", Identity: "devtool", Machine: "box-2", ClientID: "claude-1234"})
	if err != nil {
		t.Fatal(err)
	}
	if err := markSessionEnded(dir, sid, "The session was ended."); err != nil {
		t.Fatal(err)
	}
	path, _ := sessionPath(dir, sid)
	raw, _ := readPrivate(filepath.Join(dir, sessionsDir), path)
	if strings.Contains(string(raw), "cvz_s_") {
		t.Errorf("the ended session file still holds the lease: %s", raw)
	}
	if findSession(dir, "devtool", "claude-1234") != "" {
		t.Error("an ended session is not a live one to reuse")
	}
	forgetSessions(dir, sessionFile{Identity: "devtool"}, "claude-1234")
	if _, err := loadSession(dir, sid); err == nil || !strings.Contains(err.Error(), "there is no session") {
		t.Errorf("the replaced client's ended file must be gone: %v", err)
	}
}
