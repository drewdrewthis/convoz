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
)

// cliRoutes hand out the CLI of this server: the installer and the binaries. Public on the same origin, with no credential: they
// are the program every client runs, not a secret.
var cliRoutes = []Route{
	{Method: "GET", Pattern: "/install", Auth: authz.Pub, handle: (*Server).installScript},
	{Method: "GET", Pattern: "/cli/:file", Auth: authz.Pub, handle: (*Server).cliFile},
}

//go:embed install.sh
var installTemplate string

// safeOrigin is what may stand inside the single quotes of the script. The origin comes from --host, which has no quote in it;
// the check keeps a surprising one from ever becoming shell code.
var safeOrigin = regexp.MustCompile(`^https?://[A-Za-z0-9.:\[\]_-]+$`)

func (s *Server) installScript(w http.ResponseWriter, r *http.Request, _ *call) {
	if !safeOrigin.MatchString(s.Cfg.Origin) {
		writeErr(w, http.StatusInternalServerError, "install_unavailable", "This server has no address the installer can use.")
		return
	}
	body := strings.NewReplacer("__SERVER__", s.Cfg.Origin, "__VERSION__", s.Cfg.Version).Replace(installTemplate)
	h := w.Header()
	h.Set("Content-Type", "text/x-shellscript; charset=utf-8")
	h.Set("Cache-Control", "no-cache") // it names this server's version
	http.ServeContent(w, r, "", time.Time{}, strings.NewReader(body))
}

// cliFile serves convoz-<os>-<arch> and SHA256SUMS. With ?v=<this server's version> the answer is immutable: a version never
// changes its bytes. Without it (or with another version) the browser revalidates through the ETag.
func (s *Server) cliFile(w http.ResponseWriter, r *http.Request, _ *call) {
	name := r.PathValue("file")
	var body []byte
	var etag string
	contentType := "application/octet-stream"
	if name == "SHA256SUMS" {
		body, contentType = clidist.Sums(), "text/plain; charset=utf-8"
		etag = `"` + s.Cfg.Version + `-sums"`
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
