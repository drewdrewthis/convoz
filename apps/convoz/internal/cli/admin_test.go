package cli

import (
	"bytes"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// adminServer answers every request on a fresh unix socket with status and body; it returns the socket path.
func adminServer(t *testing.T, status int, body string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "convoz-cli-") // short: a unix path caps at 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "a.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return path
}

func TestAdminExitCodes(t *testing.T) {
	denied := `{"error":{"code":"x","message":"not allowed"}}`
	cases := []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{"ok", 200, `{"token":"TESTONLY","url":"https://h/bootstrap#TESTONLY","expires_at":"2030-01-01T00:00:00Z"}`, ExitOK},
		{"401 is auth", 401, denied, ExitAuth},
		{"403 is auth", 403, denied, ExitAuth},
		{"409 is conflict", 409, denied, ExitConflict},
		{"429 is rate limited", 429, denied, ExitRateLimited},
		{"500 is a plain failure", 500, denied, ExitFailure},
		{"500 without a body", 500, ``, ExitFailure},
		{"unreadable 200", 200, `not json`, ExitFailure},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		got := Admin([]string{"bootstrap-link", "--admin-socket", adminServer(t, c.status, c.body)}, &out, &errOut)
		if got != c.want {
			t.Errorf("%s: exit %d, want %d (stderr %q)", c.name, got, c.want, errOut.String())
		}
	}
}

func TestAdminSocketUnreachableExitsNetwork(t *testing.T) {
	var out, errOut bytes.Buffer
	missing := filepath.Join(t.TempDir(), "none.sock")
	if got := Admin([]string{"bootstrap-link", "--admin-socket", missing}, &out, &errOut); got != ExitNetwork {
		t.Fatalf("exit %d, want %d", got, ExitNetwork)
	}
	if !strings.Contains(errOut.String(), "cannot reach the admin socket") {
		t.Fatalf("stderr %q", errOut.String())
	}
}

func TestAdminUsageExits2(t *testing.T) {
	var out, errOut bytes.Buffer
	if got := Admin([]string{"nope"}, &out, &errOut); got != ExitUsage {
		t.Fatalf("exit %d", got)
	}
}

func TestExitCodeMapsStatusesToSection13Codes(t *testing.T) {
	cases := map[int]int{400: ExitFailure, 401: ExitAuth, 403: ExitAuth, 409: ExitConflict, 429: ExitRateLimited, 500: ExitFailure}
	for status, want := range cases {
		if got := exitCode(&statusError{status: status}); got != want {
			t.Errorf("HTTP %d: exit %d, want %d", status, got, want)
		}
	}
}
