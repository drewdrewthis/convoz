// Package httpapi builds the HTTP handler tree: the route table, the middleware chain and the handlers.
// It is a composition root: it opens Writer.Tx and calls several modules inside it.
package httpapi

import (
	"log"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Config says who this server is, as the wall sees it.
type Config struct {
	Host    string // --host without a port: the name clients use, and the WebAuthn RP ID
	Origin  string // the exact Origin a browser sends: https://Host, or http://localhost[:port] for a local Host
	Port    int    // bound TCP port; 0 on a unix listener
	Unix    bool   // the public listener is the unix socket behind `tailscale serve`
	Version string
}

// Server is the state the public handlers share. There is one per process and public listener.
type Server struct {
	Store *db.Store
	Clock platform.Clock
	WA    *webauthn.WebAuthn
	Cfg   Config
	Log   *log.Logger

	ceremonies    auth.Ceremonies
	publicLimit   auth.Limiter // 20 hits a minute per source and public route
	recoveryLimit auth.Limiter // 10 recovery attempts an hour, for everyone
}

// NewServer returns the public server state.
func NewServer(store *db.Store, clock platform.Clock, wa *webauthn.WebAuthn, cfg Config, logger *log.Logger) *Server {
	return &Server{
		Store: store, Clock: clock, WA: wa, Cfg: cfg, Log: logger,
		publicLimit:   auth.Limiter{Window: time.Minute, Max: 20},
		recoveryLimit: auth.Limiter{Window: time.Hour, Max: 10},
	}
}

// Handler is the whole public tree: the middleware chain around the route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, r := range Routes {
		mux.HandleFunc(r.Method+" "+muxPattern(r.Pattern), s.route(r))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "No such route.")
	})
	registerTestHooks(mux, s)
	return s.chain(mux)
}
