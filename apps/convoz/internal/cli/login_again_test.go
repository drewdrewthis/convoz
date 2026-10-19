package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// loggedInBox is a machine "box-2" with a stored key, a server that answers the mint with mint (called with the number of the call, from 1),
// and a count of the machine requests that reached it.
func loggedInBox(t *testing.T, mint func(n int, w http.ResponseWriter)) (run func() (int, string, string), machineRequests *atomic.Int32, dir string) {
	t.Helper()
	machineRequests = &atomic.Int32{}
	var mints atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == wire.RouteDeviceCode:
			machineRequests.Add(1)
			http.Error(w, `{"error":{"code":"forbidden","message":"stop"}}`, http.StatusForbidden)
		case r.Method == http.MethodPost && r.URL.Path == wire.RouteSessions:
			mint(int(mints.Add(1)), w)
		case r.Method == http.MethodDelete && r.URL.Path == wire.RouteSessionsMe:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	xdg := t.TempDir()
	dir = filepath.Join(xdg, "convoz")
	if err := saveCredentials(dir, brokenKeychain{}, Credentials{Server: srv.URL, Machine: "box-2", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	run = func() (int, string, string) {
		var stdout, stderr bytes.Buffer
		env := func(k string) string {
			if k == "XDG_CONFIG_HOME" {
				return xdg
			}
			return ""
		}
		code := Login([]string{"--server", srv.URL, "--name", "box-2", "--as", "Code-Review", "--store", "file"}, IO{Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr, Getenv: env})
		return code, stdout.String(), stderr.String()
	}
	return run, machineRequests, dir
}

func minted(w http.ResponseWriter) {
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(wire.MintResponse{Lease: "cvz_s_TESTONLYlease", Session: wire.SessionInfo{Identity: "code-review", Machine: "box-2"}})
}

func TestLoginAsOnALoggedInMachineAsksOnlyForTheAgent(t *testing.T) {
	run, machineRequests, dir := loggedInBox(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"request": wire.IdentityRequestState{Ref: "r1", State: "pending", IntervalMs: 1}})
			return
		}
		minted(w)
	})
	code, stdout, stderr := run()
	if code != ExitOK {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	for _, want := range []string{
		"This machine is already logged in as box-2. Asking the owner to add @code-review on it. Open Convoz, Now.",
		"Using credentials in " + dir + ".",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q lacks %q", stdout, want)
		}
	}
	if n := machineRequests.Load(); n != 0 {
		t.Errorf("%d machine requests, want 0", n)
	}
}

func TestLoginAsAnAgentTheMachineHasNeedsNoRequest(t *testing.T) {
	run, machineRequests, dir := loggedInBox(t, func(_ int, w http.ResponseWriter) { minted(w) })
	code, stdout, stderr := run()
	if code != ExitOK {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if !strings.Contains(stdout, "already allowed on this machine") || strings.Contains(stdout, "Asking the owner") {
		t.Errorf("stdout %q should say the agent is already allowed and ask nobody", stdout)
	}
	if !strings.Contains(stdout, "Using credentials in "+dir+".") {
		t.Errorf("stdout %q lacks the config dir", stdout)
	}
	if n := machineRequests.Load(); n != 0 {
		t.Errorf("%d machine requests, want 0", n)
	}
}

func TestLoginAsFallsBackToMachineLoginWhenTheStoredKeyIsRevoked(t *testing.T) {
	run, machineRequests, _ := loggedInBox(t, func(_ int, w http.ResponseWriter) {
		http.Error(w, `{"error":{"code":"unauthorized","message":"revoked"}}`, http.StatusUnauthorized)
	})
	_, _, stderr := run()
	if n := machineRequests.Load(); n != 1 {
		t.Errorf("%d machine requests, want 1 (stderr %q)", n, stderr)
	}
}
