package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func TestLoginAndSessionStartTellTheAgentToWatchAtOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == wire.RouteSessions {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"lease":"cvz_s_TESTONLYlease","session":{}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	xdg := t.TempDir()
	env := func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}

	var login bytes.Buffer
	finishLogin(IO{Stdout: &login, Stderr: &bytes.Buffer{}, Getenv: env}, filepath.Join(xdg, "convoz"), brokenKeychain{}, Credentials{Server: srv.URL, Machine: "box-2", Key: testKey}, storeFile)
	if !strings.Contains(login.String(), "convoz watch --json") {
		t.Errorf("login output lacks the watch step:\n%s", login.String())
	}

	var stdout, stderr bytes.Buffer
	code := SessionStart([]string{"--as", "devtool", "--client-id", "c1"}, IO{Stdout: &stdout, Stderr: &stderr, Getenv: env})
	if code != ExitOK {
		t.Fatalf("session start exited %d: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "convoz watch --json") {
		t.Errorf("session start lacks the watch step on stderr:\n%s", stderr.String())
	}
	if strings.Count(stdout.String(), "\n") != 1 {
		t.Errorf("stdout must stay one CONVOZ_SID line, got %q", stdout.String())
	}
}
