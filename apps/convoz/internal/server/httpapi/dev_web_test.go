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
	for name, body := range map[string]string{"index.html": "<!doctype html><title>DEV SHELL</title>", "assets/main-abc.js": "console.log(1)", "assets/main-abc.js.br": "BR-BYTES", "manifest.webmanifest": "{}"} {
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

// A hashed file under assets/ never changes under its name, so a browser keeps it for a year, as the prod console does. The page, a
// screen URL and every other file stay uncached, so a new build shows at the next load.
func TestTheOwnerGetsTheDevBuildWithItsHashedAssetsCached(t *testing.T) {
	rig := newDevRig(t, devDir(t))
	const immutable = "public, max-age=31536000, immutable"
	for path, c := range map[string]struct{ body, cache string }{
		"/dev/":                     {"DEV SHELL", "no-store"},
		"/dev/chats/12":             {"DEV SHELL", "no-store"}, // a screen URL gets the shell; the app picks the screen
		"/dev/manifest.webmanifest": {"{}", "no-store"},        // not under assets/: never a year
		"/dev/assets/main-abc.js":   {"console.log(1)", immutable},
	} {
		want := c.body
		t.Run(path, func(t *testing.T) {
			rec := rig.do("GET", path, "", nil)
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), want) {
				t.Fatalf("status %d body %q, want 200 with %q", rec.Code, rec.Body.String(), want)
			}
			if got := rec.Header().Get("Cache-Control"); got != c.cache {
				t.Errorf("Cache-Control %q, want %q", got, c.cache)
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

// The build holds a brotli copy next to each script and stylesheet (<file>.br); a client that takes brotli gets it as it is, one that
// does not gets the plain file, and the answer says it depends on Accept-Encoding.
func TestTheDevRouteSendsTheBrotliCopyToAClientThatTakesIt(t *testing.T) {
	rig := newDevRig(t, devDir(t))
	t.Run("a client that takes br gets the .br copy", func(t *testing.T) {
		rec := rig.do("GET", "/dev/assets/main-abc.js", "", map[string]string{"Accept-Encoding": "gzip, br"})
		if rec.Code != http.StatusOK || rec.Body.String() != "BR-BYTES" {
			t.Fatalf("status %d body %q, want 200 with the .br bytes", rec.Code, rec.Body.String())
		}
		h := rec.Header()
		if h.Get("Content-Encoding") != "br" || h.Get("Vary") != "Accept-Encoding" {
			t.Errorf("Content-Encoding %q Vary %q, want br and Accept-Encoding", h.Get("Content-Encoding"), h.Get("Vary"))
		}
		if got := h.Get("Content-Type"); !strings.Contains(got, "javascript") {
			t.Errorf("Content-Type %q, want the type of the plain file, not of the .br", got)
		}
		if got := h.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Errorf("Cache-Control %q, want immutable", got)
		}
	})
	t.Run("a client that does not take br gets the plain file", func(t *testing.T) {
		for _, accept := range []string{"", "gzip", "br;q=0"} {
			rec := rig.do("GET", "/dev/assets/main-abc.js", "", map[string]string{"Accept-Encoding": accept})
			if rec.Body.String() != "console.log(1)" || rec.Header().Get("Content-Encoding") != "" {
				t.Errorf("Accept-Encoding %q: body %q Content-Encoding %q, want the plain file", accept, rec.Body.String(), rec.Header().Get("Content-Encoding"))
			}
			if rec.Header().Get("Vary") != "Accept-Encoding" {
				t.Errorf("Accept-Encoding %q: Vary %q, want Accept-Encoding", accept, rec.Header().Get("Vary"))
			}
		}
	})
	t.Run("a file with no .br copy is sent plain", func(t *testing.T) {
		rec := rig.do("GET", "/dev/", "", map[string]string{"Accept-Encoding": "br"})
		if !strings.Contains(rec.Body.String(), "DEV SHELL") || rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("body %q Content-Encoding %q, want the plain page", rec.Body.String(), rec.Header().Get("Content-Encoding"))
		}
	})
}
