package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
)

// handler is one route's code. c carries the caller already authenticated for the route's Auth class.
type handler func(s *Server, w http.ResponseWriter, r *http.Request, c *call)

// Route is one row of the route table: the mux is built from these rows, and GET /__test/routes lists them.
type Route struct {
	Method  string
	Pattern string // ":name" segments are path parameters
	Auth    authz.Auth
	StepUp  string // the action the request must carry a step-up for ("" for none)
	Page    bool   // a browser page: a caller who is not signed in is redirected, not told 401

	Lease       bool   // a session lease also meets the route (the route lists L next to its Auth class)
	Scope       string // the scope a lease needs for this route ("" for none); a lease without it is told 403 (I-6)
	RefuseLease bool   // a lease is told 403, not 401: an agent credential can never do this
	NoCSRF      bool   // a write that carries no cookie and no Authorization (a CLI), so the browser Origin check does not apply
	NoLimit     bool   // exempt from the per-source public limit (its own protocol limits it)
	handle      handler
}

// check is Auth.Check, widened by Lease.
func (r Route) check(p authz.Principal) error {
	if r.Lease && p.SessionID != 0 {
		return nil
	}
	return r.Auth.Check(p)
}

// Routes is the whole public API: the owner's, the machines', the agents', and the chat routes both people and agents use.
// Each module keeps its rows in its own routes_<module>.go, so parallel work never edits this list.
var Routes = slices.Concat(
	coreRoutes, authRoutes, identityRoutes, auditRoutes, conversationRoutes, messageRoutes, readstateRoutes, eventRoutes, inboxRoutes,
	askRoutes, prefsRoutes, uploadRoutes, transcriptRoutes, searchRoutes, notifyRoutes, settingsRoutes, unfurlRoutes, appkitRoutes, opsRoutes,
)

func appPage(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { console.Page(w, r) }

func appAsset(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { console.Asset(w, r) }

func file(name, contentType string) handler {
	serve := console.File(name, contentType)
	return func(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) { serve(w, r) }
}

// lookalikes is the asset body and its strong ETag, built once: the table is pinned at build time and never changes.
var lookalikes = sync.OnceValues(func() ([]byte, string) {
	set, _ := json.Marshal(identity.PunctuationLookalikes())
	body := append([]byte("globalThis.CONVOZ_LOOKALIKES="), append(set, ';')...)
	sum := sha256.Sum256(body)
	return body, `"` + hex.EncodeToString(sum[:]) + `"`
})

// lookalikesAsset hands the confusable-punctuation set to the web app's markdown renderer, so the identity table stays its only owner.
// no-cache with an ETag: the browser revalidates every time and gets a 304 while the table is unchanged.
func lookalikesAsset(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) {
	body, etag := lookalikes()
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", etag)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body)) // answers If-None-Match (weak, lists, "*") and HEAD
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request, _ *call) {
	_, _ = w.Write([]byte("ok"))
}
