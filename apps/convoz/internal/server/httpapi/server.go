// Package httpapi builds the HTTP handler tree: the route table, the middleware chain and the handlers.
// It is a composition root: it opens Writer.Tx and calls several modules inside it.
package httpapi

import (
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ops"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// Config says who this server is, as the wall sees it.
type Config struct {
	Host       string // --host without a port: the name clients use, and the WebAuthn RP ID
	Origin     string // the exact Origin a browser sends: https://Host, or http://localhost[:port] for a local Host
	Port       int    // bound TCP port; 0 on a unix listener
	PublicPort int    // the port clients type (the `tailscale serve` HTTPS port); 0 for 443
	Unix       bool   // the public listener is the unix socket behind `tailscale serve`
	Version    string

	// TailscaleBin is the tailscale command; TailscaleOn says whether to ask it who a source address is.
	// Node identity comes from `tailscale whois`; it is shown to the owner and never trusted as a login.
	TailscaleBin string
	TailscaleOn  bool

	// The agents-only listener (design §3.6). AgentHost is the public name (the Funnel host); AgentOrigin is what agents are told to use.
	// All four are zero when the listener is off.
	AgentHost       string
	AgentPublicPort int // the port agents type; 0 for 443
	AgentPort       int // bound TCP port of the agent listener
	AgentOrigin     string
	// AgentApproveCode makes the owner type the last 4 characters of the code to approve an internet request (--agent-approve-code).
	AgentApproveCode bool

	// DataDir and BlobKey (the keyring's blob DEK) open the sealed upload files under <DataDir>/blobs. Without them there are no uploads.
	DataDir string
	BlobKey []byte
}

// Server is the state the public handlers share. There is one per process and public listener.
type Server struct {
	Store *db.Store
	Clock platform.Clock
	WA    *webauthn.WebAuthn
	Cfg   Config
	Log   *log.Logger

	Keys *auth.KeyBox    // seals and opens the stored copy of each machine key
	Push *notify.Service // the push pipeline; nil until EnablePush (a server without push keys sends nothing)
	Bus  *platform.Bus   // wakes streams and long polls after a commit; never carries data

	csrfExempt map[string]bool  // "METHOD /path" of the NoCSRF routes
	readRoutes map[string]Route // the route of each read a cold page carries inline, by path (firstReadRoutes)
	userCodes  func() string    // the next device-flow user code; random unless the test hooks seed some

	ceremonies    auth.Ceremonies
	publicLimit   auth.Limiter // 20 hits a minute per source and public route
	recoveryLimit auth.Limiter // 10 recovery attempts an hour, for everyone
	// tokenMissLimit counts device-token polls with a code that is not live, per source. A real client stops
	// at its first expired_token, so 30 a minute is loose.
	tokenMissLimit auth.Limiter
	// postLimit is 1 message a second per agent identity with a burst of 20: at most 20 in any 20 seconds (design §13.1).
	postLimit auth.Limiter
	// statusLimit is 1 status update every 5 seconds per agent identity with a burst of 10: at most 10 in any 50 seconds (design §13.1).
	statusLimit auth.Limiter
	// dayIdentityLimit and dayMachineLimit are the daily message caps of an agent identity and of a machine (design §13.1).
	dayIdentityLimit auth.Limiter
	dayMachineLimit  auth.Limiter
	// The agent listener's limits per client address (agent.go).
	agentStartLimit, agentStartAll, agentPollLimit, agentFailLimit, agentDownloadLimit auth.Limiter
	agentInflight                                                                      inflight
	streams                                                                            streamSet
	maintainedAt                                                                       atomic.Int64  // server time (unix ms) of the last clean-up run Maintain made on a list read
	maintaining                                                                        sync.Mutex    // held while a list read runs the clean-up, so a second list read waits for it instead of reading the list before the clean-up
	exports                                                                            ops.Exports   // export jobs; the zero value is ready
	heartbeat                                                                          time.Duration // how often a quiet stream sends ": hb" and checks its device; heartbeatEvery unless a test shortens it
}

// Daily message caps (design §13.1).
const (
	dayMessagesIdentity = 5_000
	dayMessagesMachine  = 20_000
)

// NewServer returns the public server state.
func NewServer(store *db.Store, clock platform.Clock, wa *webauthn.WebAuthn, keys *auth.KeyBox, cfg Config, logger *log.Logger) *Server {
	exempt := map[string]bool{}
	for _, r := range Routes {
		if r.NoCSRF {
			exempt[r.Method+" "+r.Pattern] = true
		}
	}
	if len(cfg.BlobKey) == 32 && cfg.DataDir != "" {
		if blobs, err := upload.NewBlobs(cfg.DataDir, cfg.BlobKey); err != nil {
			logger.Printf("uploads are off: %v", err)
		} else {
			files.Store(upload.NewService(blobs))
		}
	}
	return &Server{
		Store: store, Clock: clock, WA: wa, Keys: keys, Cfg: cfg, Log: logger, csrfExempt: exempt, readRoutes: firstReadRoutes(), userCodes: auth.NewUserCode,
		publicLimit:        auth.Limiter{Window: time.Minute, Max: 20},
		recoveryLimit:      auth.Limiter{Window: time.Hour, Max: 10},
		tokenMissLimit:     auth.Limiter{Window: time.Minute, Max: 30},
		postLimit:          auth.Limiter{Window: 20 * time.Second, Max: 20},
		statusLimit:        auth.Limiter{Window: 50 * time.Second, Max: 10},
		agentStartLimit:    auth.Limiter{Window: time.Hour, Max: agentStartsPerHour},
		agentStartAll:      auth.Limiter{Window: time.Hour, Max: agentStartsAllPerHour},
		agentDownloadLimit: auth.Limiter{Window: time.Hour, Max: agentDownloadsPerHour},
		agentPollLimit:     auth.Limiter{Window: time.Minute, Max: agentPollsPerMin},
		agentFailLimit:     auth.Limiter{Window: agentFailWindow, Max: agentFailsPer10Min},
		Bus:                platform.NewBus(),
		heartbeat:          heartbeatEvery,
		dayIdentityLimit:   auth.Limiter{Window: 24 * time.Hour, Max: dayMessagesIdentity},
		dayMachineLimit:    auth.Limiter{Window: 24 * time.Hour, Max: dayMessagesMachine},
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
	s.startTranscriber()
	return s.chain(mux)
}
