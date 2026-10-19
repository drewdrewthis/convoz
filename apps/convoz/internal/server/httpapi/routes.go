package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
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
	// Agent is the reason the agent listener serves a route that needs no credential ("" refuses it there). A route that a
	// lease (Lease) or a machine key (Auth) meets is served without saying so; see AgentReason.
	Agent  string
	handle handler
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
	coreRoutes, cliRoutes, authRoutes, identityRoutes, auditRoutes, conversationRoutes, messageRoutes, readstateRoutes, eventRoutes, inboxRoutes,
	askRoutes, prefsRoutes, uploadRoutes, transcriptRoutes, searchRoutes, notifyRoutes, settingsRoutes, unfurlRoutes, appkitRoutes, opsRoutes, planRoutes, voiceRoutes,
)

// appPage serves the app for a page URL: the cold page with the first screen's reads inline when this page has a first screen
// and the browser itself asks (design §12.2), else the lean shell. The caller is already authenticated for the page's route.
func appPage(s *Server, w http.ResponseWriter, r *http.Request, _ *call) {
	// A HEAD has no body to carry the reads, and they may write (Now wakes snoozes): it gets the lean page's headers.
	if cold != nil && !console.Lean(r) && r.Method != http.MethodHead {
		if data := s.firstReads(r); data != nil {
			cold.Serve(w, r, data, chooseEncoding(r.Header.Get("Accept-Encoding")) == "br")
			return
		}
	}
	console.Page(w, r)
}

// cold is this build's cold page (nil without a web build); its tail carries the confusables set, which the app's markdown reads.
var cold = func() *console.ColdPage {
	body, _ := lookalikes()
	page, err := console.NewColdPage(settings.BootScript, body)
	if err != nil {
		panic(err)
	}
	return page
}()

// firstReadRoutes are the route rows of every read a first screen carries inline. A read the table does not serve as a GET is a
// build defect, found when the server is made.
func firstReadRoutes() map[string]Route {
	out := map[string]Route{}
	for page, reads := range console.FirstReads() {
		for _, path := range reads {
			i := slices.IndexFunc(Routes, func(rt Route) bool { return rt.Method == http.MethodGet && rt.Pattern == path })
			if i < 0 {
				panic("httpapi: the first screen of " + page + " reads " + path + ", which is no GET route")
			}
			out[path] = Routes[i]
		}
	}
	return out
}

var firstReadsByPage = console.FirstReads()

// firstReads runs each read of this page's first screen as the request's own GET of that route, through the route's own
// authentication and Auth class (s.route), and returns them as the data block. A read that does not answer 200 is left out (the
// app asks for it itself); with none left, or a page with no first screen, it returns nil and the page is the lean shell, never
// a page with empty data.
func (s *Server) firstReads(r *http.Request) []byte {
	reads := firstReadsByPage[r.URL.Path]
	if len(reads) == 0 {
		return nil
	}
	answers := map[string]json.RawMessage{}
	for _, path := range reads {
		q := r.Clone(r.Context())
		q.Method, q.URL, q.RequestURI, q.Body, q.ContentLength = http.MethodGet, &url.URL{Path: path}, path, http.NoBody, 0
		q.Header.Del("Accept-Encoding")
		q.Header.Del(console.LeanHeader)
		rec := &recorder{header: http.Header{}, status: http.StatusOK}
		s.route(s.readRoutes[path])(rec, q)
		if rec.status == http.StatusOK && json.Valid(rec.body.Bytes()) {
			answers[path] = rec.body.Bytes()
		}
	}
	if len(answers) == 0 {
		return nil
	}
	data, err := console.DataBlock(s.Clock.Now(), answers)
	if err != nil {
		s.Log.Printf("cold page: %v", err)
		return nil
	}
	return data
}

// recorder keeps one in-process answer: its status, headers and body.
type recorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *recorder) Header() http.Header         { return w.header }
func (w *recorder) WriteHeader(status int)      { w.status = status }
func (w *recorder) Write(p []byte) (int, error) { return w.body.Write(p) }

func appAsset(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) {
	console.Asset(w, r, chooseEncoding(r.Header.Get("Accept-Encoding")) == "br")
}

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
