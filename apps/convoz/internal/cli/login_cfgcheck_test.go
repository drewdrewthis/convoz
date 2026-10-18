package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLoginStopsBeforeAnyRequestWhenConfigFolderIsReadOnly(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory modes")
	}
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	xdg := t.TempDir()
	if err := os.Chmod(xdg, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(xdg, 0o700)
	env := func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}
	for _, args := range [][]string{
		{"--server", srv.URL, "--name", "box-2", "--store", "file"},
		{"--server", srv.URL, "--name", "box-2"}, // auto, and no keychain answers
	} {
		var stderr bytes.Buffer
		code := Login(args, IO{Stdin: strings.NewReader(""), Stdout: &bytes.Buffer{}, Stderr: &stderr, Getenv: env})
		if code != ExitAuth {
			t.Errorf("%v: exit %d, want %d", args, code, ExitAuth)
		}
		want := "convoz: cannot write " + filepath.Join(xdg, "convoz") + ": permission denied. Set XDG_CONFIG_HOME to a writable folder, or use --store keychain"
		if !strings.Contains(stderr.String(), want) {
			t.Errorf("%v: stderr %q lacks %q", args, stderr.String(), want)
		}
	}
	if n := requests.Load(); n != 0 {
		t.Errorf("%d requests reached the server, want 0", n)
	}
}
