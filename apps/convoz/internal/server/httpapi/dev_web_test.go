package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// devDir lays out the dev folder as prod has it and returns the --dev-web-dir value, the current symlink to the live build. Next
// to the folder sits a secret file; the build holds a symlink out to it, and two symlinks that stay inside the tree.
func devDir(t *testing.T) string {
	t.Helper()
	top := t.TempDir()
	if err := os.WriteFile(filepath.Join(top, "secret.txt"), []byte("SECRET-OUTSIDE"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(top, "dev")
	build := filepath.Join(dir, "releases", "20261028T120000Z-abc1234")
	for name, body := range map[string]string{"index.html": "<!doctype html><title>DEV SHELL</title>", "assets/main-abc.js": "console.log(1)"} {
		p := filepath.Join(build, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(top, "secret.txt"), filepath.Join(build, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("assets", "main-abc.js"), filepath.Join(build, "inside.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("assets", filepath.Join(build, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("releases", "20261028T120000Z-abc1234"), filepath.Join(dir, "current")); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "current")
}

func newDevRig(t *testing.T, dir string) *telRig {
	t.Helper()
	rig := newTelRig(t, nil)
	rig.s.Cfg.DevWebDir = dir
	return rig
}

func TestTheOwnerGetsTheDevBuildUncached(t *testing.T) {
	rig := newDevRig(t, devDir(t))
	for path, want := range map[string]string{
		"/dev/":                   "DEV SHELL",
		"/dev/chats/12":           "DEV SHELL", // a screen URL gets the shell; the app picks the screen
		"/dev/assets/main-abc.js": "console.log(1)",
	} {
		t.Run(path, func(t *testing.T) {
			rec := rig.do("GET", path, "", nil)
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), want) {
				t.Fatalf("status %d body %q, want 200 with %q", rec.Code, rec.Body.String(), want)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control %q, want no-store", got)
			}
			if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "script-src 'self'") {
				t.Errorf("Content-Security-Policy %q, want the console's policy", got)
			}
		})
	}
	t.Run("/dev sends the owner to /dev/", func(t *testing.T) {
		rec := rig.do("GET", "/dev", "", nil)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/dev/" {
			t.Errorf("status %d Location %q, want 302 to /dev/", rec.Code, rec.Header().Get("Location"))
		}
	})
	t.Run("a missing build file is a 404, not the shell", func(t *testing.T) {
		if rec := rig.do("GET", "/dev/assets/gone.js", "", nil); rec.Code != http.StatusNotFound {
			t.Errorf("status %d, want 404", rec.Code)
		}
	})
}

func TestTheDevBuildIsA404ForEveryoneButTheOwner(t *testing.T) {
	rig := newDevRig(t, devDir(t))
	lease := rig.mintAgentLease(t)
	for name, c := range map[string]struct {
		cookie string
		header map[string]string
	}{
		"signed out":            {},
		"an agent's lease":      {header: map[string]string{"Authorization": "Bearer " + lease}},
		"an unknown bearer":     {header: map[string]string{"Authorization": "Bearer cvz_s_TESTONLYnotalease"}},
		"a lease with a cookie": {cookie: rig.cookie, header: map[string]string{"Authorization": "Bearer " + lease}},
		"an unknown cookie":     {cookie: "not-a-device"},
	} {
		for _, path := range []string{"/dev", "/dev/", "/dev/chats", "/dev/assets/main-abc.js"} {
			t.Run(name+" "+path, func(t *testing.T) {
				rec := rig.send(c.cookie, "GET", path, "", c.header)
				if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "DEV SHELL") {
					t.Errorf("status %d body %q, want a 404 like an unknown path", rec.Code, rec.Body.String())
				}
			})
		}
	}
}

func TestTheDevRouteNeverLeavesItsFolder(t *testing.T) {
	rig := newDevRig(t, devDir(t))
	for _, path := range []string{"/dev/../secret.txt", "/dev/%2e%2e/secret.txt", "/dev/%2e%2e%2fsecret.txt", "/dev/..%2f..%2fsecret.txt", "/dev/escape.txt", "/dev/current/../../secret.txt"} {
		t.Run(path, func(t *testing.T) {
			rec := rig.do("GET", path, "", nil)
			if strings.Contains(rec.Body.String(), "SECRET-OUTSIDE") {
				t.Fatalf("status %d served the file outside the folder", rec.Code)
			}
			if rec.Code == http.StatusOK && !strings.Contains(rec.Body.String(), "DEV SHELL") {
				t.Errorf("status 200 with %q, want a 404, a redirect or the shell", rec.Body.String())
			}
		})
	}
	for _, path := range []string{"/dev/escape.txt", "/dev/inside.js", "/dev/linked/main-abc.js"} {
		t.Run("a symlink in the build is a 404: "+path, func(t *testing.T) {
			if rec := rig.do("GET", path, "", nil); rec.Code != http.StatusNotFound {
				t.Errorf("status %d body %q, want 404", rec.Code, rec.Body.String())
			}
		})
	}
}

// The deploy renames a new current symlink over the old one: the next request reads the new build, with no restart.
func TestANewDevBuildShowsAtTheNextRequest(t *testing.T) {
	current := devDir(t)
	rig := newDevRig(t, current)
	next := filepath.Join(filepath.Dir(current), "releases", "20261028T130000Z-def5678")
	if err := os.MkdirAll(next, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(next, "index.html"), []byte("<title>NEXT BUILD</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	tmp := current + ".new"
	if err := os.Symlink(filepath.Join("releases", "20261028T130000Z-def5678"), tmp); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, current); err != nil {
		t.Fatal(err)
	}
	if rec := rig.do("GET", "/dev/", "", nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "NEXT BUILD") {
		t.Errorf("status %d body %q, want the new build", rec.Code, rec.Body.String())
	}
}

func TestTheDevRouteIsOffWithoutItsFolder(t *testing.T) {
	for name, dir := range map[string]string{"no folder set": "", "a folder that is missing": filepath.Join(t.TempDir(), "none"), "a folder with no build": t.TempDir()} {
		t.Run(name, func(t *testing.T) {
			rig := newDevRig(t, dir)
			for _, path := range []string{"/dev/", "/dev/chats"} {
				if rec := rig.do("GET", path, "", nil); rec.Code != http.StatusNotFound {
					t.Errorf("%s: status %d, want 404", path, rec.Code)
				}
			}
		})
	}
}

func TestTheDevRouteIsTheOwnersAndNotTheAgentPorts(t *testing.T) {
	found := 0
	for _, rt := range Routes {
		if rt.Pattern != "/dev" && !strings.HasPrefix(rt.Pattern, "/dev/") {
			continue
		}
		found++
		if _, served := rt.AgentReason(); served || rt.Auth.String() != "O" || !rt.Hidden || rt.Lease {
			t.Errorf("route %+v: want owner only, hidden, no lease, not on the agent listener", rt)
		}
	}
	if found != 2 {
		t.Errorf("%d dev routes, want 2 (/dev and /dev/{path...})", found)
	}
}
