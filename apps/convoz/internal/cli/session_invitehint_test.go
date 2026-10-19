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

// Over the internet the server answers a --create with no usable invite by a fake pending request, and then has no such
// request (@cloud-tech, conv 5 msg 940). The CLI cannot tell the internet door from the tailnet one by the server URL, so
// the 404 after a pending answer is where it says what is missing.
func TestCreateWithoutInviteThatMeetsNoSuchRequestSaysAnInviteIsNeeded(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != wire.RouteSessions {
			http.NotFound(w, r)
			return
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"request":{"ref":"idr_fake","state":"pending","interval_ms":1}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"No such request."}}`))
	}))
	defer srv.Close()
	env := credentialsEnv(t, srv.URL)

	var stdout, stderr bytes.Buffer
	code := SessionStart([]string{"--as", "rexxy", "--create", "--name", "Rexxy", "--client-id", "rexxy-hetzner"}, IO{Stdout: &stdout, Stderr: &stderr, Getenv: env})
	if code != ExitUsage {
		t.Errorf("exit %d, want 2: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Over the internet a new agent needs a one-use invite.") || !strings.Contains(stderr.String(), "convoz invite --as <handle> --conv <id>") {
		t.Errorf("stderr lacks the invite hint:\n%s", stderr.String())
	}
	if strings.Contains(stderr.String(), "No such request.") {
		t.Errorf("stderr still shows the bare 404:\n%s", stderr.String())
	}
}

// With an invite the old words stay: the invite itself may be the problem.
func TestCreateWithInviteThatMeetsNoSuchRequestKeepsTheInviteWords(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"request":{"ref":"idr_x","state":"pending","interval_ms":1}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"No such request."}}`))
	}))
	defer srv.Close()

	var stderr bytes.Buffer
	code := SessionStart([]string{"--as", "rexxy", "--create", "--invite", "TESTONLYinvite", "--client-id", "c1"}, IO{Stdout: &bytes.Buffer{}, Stderr: &stderr, Getenv: credentialsEnv(t, srv.URL)})
	if code == ExitOK || !strings.Contains(stderr.String(), "the invite may be used, revoked or older than 24 hours") {
		t.Errorf("exit %d, stderr:\n%s", code, stderr.String())
	}
}

// credentialsEnv logs a fake machine in to server and returns the Getenv that points the CLI at it.
func credentialsEnv(t *testing.T, server string) func(string) string {
	t.Helper()
	xdg := t.TempDir()
	if err := saveCredentials(filepath.Join(xdg, "convoz"), brokenKeychain{}, Credentials{Server: server, Machine: "box-2", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	return func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}
}
