package httpapi

import (
	"bytes"
	_ "embed"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/clidist"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// cliRoutes hand out the CLI of this server: the installer and the binaries. Public on the same origin, with no credential: they
// are the program every client runs, not a secret.
var cliRoutes = []Route{
	{Method: "GET", Pattern: "/install", Auth: authz.Pub, Agent: "an agent installs the CLI", handle: (*Server).installScript},
	{Method: "GET", Pattern: "/cli/:file", Auth: authz.Pub, Agent: "an agent installs the CLI", handle: (*Server).cliFile},
	{Method: "GET", Pattern: wire.RouteRules, Auth: authz.Pub, Agent: "an agent reads the rules, whatever its CLI version", handle: (*Server).rulesText},
}

// rulesText is GET /api/rules: the rules every agent follows, from the one Go source (wire.RulesText).
func (*Server) rulesText(w http.ResponseWriter, _ *http.Request, _ *call) {
	w.Header().Set("Cache-Control", "no-cache") // a rule change reaches the next run
	writeJSON(w, http.StatusOK, wire.RulesResponse{Text: wire.RulesText})
}

//go:embed install.sh
var installTemplate string

// safeOrigin is what may stand inside the single quotes of the script. The origin comes from --host, which has no quote in it;
// the check keeps a surprising one from ever becoming shell code.
var safeOrigin = regexp.MustCompile(`^https?://[A-Za-z0-9.:\[\]_-]+$`)

func (s *Server) installScript(w http.ResponseWriter, r *http.Request, _ *call) {
	origin := s.Cfg.Origin
	if agentClient(r.Context()) != "" {
		origin = s.Cfg.AgentOrigin // an agent on the internet cannot reach the tailnet name
	}
	if !safeOrigin.MatchString(origin) {
		writeErr(w, http.StatusInternalServerError, "install_unavailable", "This server has no address the installer can use.")
		return
	}
	body := strings.NewReplacer("__SERVER__", origin, "__VERSION__", s.Cfg.Version).Replace(installTemplate)
	h := w.Header()
	h.Set("Content-Type", "text/x-shellscript; charset=utf-8")
	h.Set("Cache-Control", "no-cache") // it names this server's version
	http.ServeContent(w, r, "", time.Time{}, strings.NewReader(body))
}

// cliFile serves convoz-<os>-<arch>, convoz-<os>-<arch>.sha256 (the digest of that binary, in the format of sha256sum) and SHA256SUMS. With ?v=<this server's version> the answer is immutable: a version never
// changes its bytes. Without it (or with another version) the browser revalidates through the ETag.
func (s *Server) cliFile(w http.ResponseWriter, r *http.Request, _ *call) {
	name := r.PathValue("file")
	var body []byte
	var etag string
	contentType := "application/octet-stream"
	if name == "SHA256SUMS" {
		body, contentType = clidist.Sums(), "text/plain; charset=utf-8"
		etag = `"` + s.Cfg.Version + `-sums"`
	} else if bin, isSum := strings.CutSuffix(name, ".sha256"); isSum {
		if f, ok := clidist.Lookup(bin); ok {
			body, contentType, etag = []byte(f.SHA256+"  "+bin+"\n"), "text/plain; charset=utf-8", `"`+f.SHA256+`-sum"`
		}
	} else if f, ok := clidist.Lookup(name); ok {
		body, etag = f.Body, `"`+f.SHA256+`"`
	}
	if len(body) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "This server has no such CLI file.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("ETag", etag)
	if r.URL.Query().Get("v") == s.Cfg.Version {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body)) // answers HEAD, Range and If-None-Match
}
