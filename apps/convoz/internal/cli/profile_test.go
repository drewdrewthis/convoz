package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// profileServer records each PATCH of the profile and answers as the server does for an avatar alone: the URL, no words.
type profileServer struct {
	mu      sync.Mutex
	patches []map[string]any
}

func (p *profileServer) handle(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case r.Method == "PATCH" && r.URL.Path == wire.RouteProfile:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		p.patches = append(p.patches, body)
		_, _ = w.Write([]byte(`{"handle":"","display_name":"","description":"","capabilities":null,"avatar_url":"/api/identities/2/avatar.svg?v=0123456789abcdef"}`))
	case r.Method == "GET" && r.URL.Path == wire.RouteMe:
		_, _ = w.Write([]byte(`{"identity":{"id":2,"handle":"devtool","display_name":"Dev Tool","kind":"agent","description":"Builds"}}`))
	default:
		http.NotFound(w, r)
	}
}

// An agent changes its avatar later (crew.feature): the CLI sends the file's SVG text and refuses a file that is no SVG unsent.
func TestProfileSetsTheAvatarFromAnSVGFile(t *testing.T) {
	var p profileServer
	run := agentRun(t, p.handle)
	dir := t.TempDir()
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#27a"/></svg>`
	good := filepath.Join(dir, "new.svg")
	notSVG := filepath.Join(dir, "photo.svg")
	if err := os.WriteFile(good, []byte(svg), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(notSVG, []byte("\x89PNG\r\n\x1a\n not a picture we take"), 0o600); err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr := run(Profile, "--set", "avatar="+good)
	if code != ExitOK || stderr != "" {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	if len(p.patches) != 1 || p.patches[0]["avatar_svg"] != svg {
		t.Fatalf("the PATCH must carry the file's SVG text: %v", p.patches)
	}
	if !strings.Contains(stdout, "@devtool") || !strings.Contains(stdout, "avatar changed") {
		t.Errorf("stdout %q must show the profile and the change", stdout)
	}

	code, _, stderr = run(Profile, "--set", "avatar="+notSVG)
	if code != ExitUsage || !strings.Contains(stderr, "not an SVG") || len(p.patches) != 1 {
		t.Errorf("a file that is no SVG: exit %d stderr %q patches %d, want a usage error and nothing sent", code, stderr, len(p.patches))
	}
}
