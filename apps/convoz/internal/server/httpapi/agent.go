package httpapi

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
)

// The agent listener is a second, agents-only door (design §3.4a): the one `tailscale funnel` points at. It serves the
// routes Route.AgentReason allows and answers 404 to every other path. The list is derived from the route table and is
// an allow-list: a route that says nothing is refused.

// viaInternet marks a device request that came in on the agent listener. It prefixes the stored source, so the owner's
// card can say "via internet" without a new column; per-source limits still count the bare address after the prefix.
const viaInternet = "internet:"

// funnelMarker is the header the Tailscale Funnel proxy adds to every request it forwards.
const funnelMarker = "Tailscale-Funnel-Request"

type agentIPKey struct{}

// agentClient is the client address of a request served by the agent listener; "" on the owner's listener.
func agentClient(ctx context.Context) string {
	ip, _ := ctx.Value(agentIPKey{}).(string)
	return ip
}

// AgentReason says why the agent listener serves this route, and whether it does. Three roads lead in: the route
// names itself (Agent, for the few that need no credential), a session lease meets it, or a machine key does.
// Nothing else is served: owner pages and routes, approvals, passkeys, push, settings and admin stay on the owner's listener.
func (r Route) AgentReason() (string, bool) {
	switch {
	case r.Agent != "":
		return r.Agent, true
	case r.Lease || r.Auth == authz.Lease:
		return "session lease", true
	case r.Auth == authz.Machine:
		return "machine key", true
	}
	return "", false
}

// AgentReadTimeout bounds the reading of a whole request on the agent listener (headers and body): the door faces the internet,
// so a body that trickles in is cut. A request with no body, or whose body has been read, drops the deadline (clearReadDeadline).
const AgentReadTimeout = 30 * time.Second

// AgentHTTPServer is the server of the agent listener. readTimeout is AgentReadTimeout unless a test shortens it.
func (s *Server) AgentHTTPServer(ctx context.Context, logger *log.Logger, readTimeout time.Duration) *http.Server {
	return &http.Server{
		Handler:           s.AgentHandler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       readTimeout,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 16,
		ErrorLog:          logger,
	}
}

// AgentHandler is the whole tree of the agent listener. Requests carry no cookie here, so no owner right can reach it.
func (s *Server) AgentHandler() http.Handler {
	mux := http.NewServeMux()
	for _, r := range Routes {
		if _, ok := r.AgentReason(); ok {
			mux.HandleFunc(r.Method+" "+muxPattern(r.Pattern), s.route(r))
		}
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "No such route.") // the same answer as an unknown path on the owner's listener
	})
	s.startTranscriber()
	h := rejectForeignCredential(mux)
	h = s.agentLimits(h)
	h = rejectCredentialInURL(h)
	h = s.checkAgentHost(h)
	h = securityHeaders(h)
	h = compress(h)
	h = s.logRequests(h)
	return clearReadDeadline(s.identifyAgent(h))
}

// identifyAgent fixes who is calling and removes what must not count here. A request whose client cannot be told is refused with
// 400, never put in a shared bucket. The cookie goes before routing: an owner session cookie gives no rights on this listener.
// Forwarding headers are read once, then dropped.
func (s *Server) identifyAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, ok := clientIP(r)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "This request did not come through the agent address.")
			return
		}
		r.Header.Del("Cookie")
		for name := range r.Header {
			l := strings.ToLower(name)
			if strings.HasPrefix(l, "x-forwarded-") || l == "forwarded" || l == "x-real-ip" {
				r.Header.Del(name)
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), agentIPKey{}, ip)))
	})
}

// canonicalIP is the address as stored and logged: IPv4-mapped IPv6 becomes the IPv4 address, and a zone is dropped.
func canonicalIP(a netip.Addr) string { return a.Unmap().WithZone("").String() }

// limitKey is what the limits count: an IPv4 address, or the /64 of an IPv6 address (one subscriber holds a whole /64).
func limitKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || a.Is4() {
		return ip
	}
	return netip.PrefixFrom(a, 64).Masked().String()
}

// clientIP is who sent the request. Behind the local Funnel proxy (a loopback peer that sets Tailscale-Funnel-Request) it is the
// last X-Forwarded-For entry, the one the proxy added. A loopback peer without the marker is not Funnel and its header is a
// stranger's: there is no client (false). So is a marked request with no valid address. A non-loopback peer is itself.
func clientIP(r *http.Request) (string, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "", false
	}
	if !peer.Unmap().IsLoopback() {
		return canonicalIP(peer), true
	}
	if r.Header.Get(funnelMarker) == "" {
		if agentPeerTrusted() {
			return canonicalIP(peer), true
		}
		return "", false
	}
	parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	ip, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1]))
	if err != nil {
		return "", false
	}
	return canonicalIP(ip), true
}

// checkAgentHost refuses any Host that is not the agent name: the name alone, with the public port, or with the bound port.
func (s *Server) checkAgentHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.agentHostOK(strings.ToLower(r.Host)) {
			writeErr(w, http.StatusMisdirectedRequest, "misdirected", "This server does not answer to that name.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) agentHostOK(host string) bool {
	name := strings.ToLower(s.Cfg.AgentHost)
	if h, p, err := net.SplitHostPort(host); err == nil {
		host = net.JoinHostPort(strings.TrimSuffix(h, "."), p) // a fully qualified name ends in a dot
	} else {
		host = strings.TrimSuffix(host, ".")
	}
	if host == name || host == net.JoinHostPort(name, strconv.Itoa(s.Cfg.AgentPort)) {
		return true
	}
	public := s.Cfg.AgentPublicPort
	if public == 0 {
		public = 443
	}
	return host == net.JoinHostPort(name, strconv.Itoa(public))
}

// Limits of the internet-facing door. Per client address (an IPv6 /64 counts as one), on top of the per-machine caps.
const (
	agentStartsPerHour    = 10 // POST /api/device/code
	agentStartsAllPerHour = 20 // POST /api/device/code from everyone together: a flood from many addresses still cannot fill the feed
	agentPollsPerMin      = 60 // POST /api/device/token; a CLI polls every 5 s
	agentFailsPer10Min    = 30 // answers of 401: a guess at a credential
	agentFailWindow       = 10 * time.Minute
	agentDownloadsPerHour = 30 // /install and /cli/*
	agentInflightPerIP    = 20 // requests being served at once, long polls included
)

// inflight counts the requests being served per key.
type inflight struct {
	mu sync.Mutex
	n  map[string]int
}

// acquire takes a slot for key; false when max are already in use.
func (f *inflight) acquire(key string, max int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n == nil {
		f.n = map[string]int{}
	}
	if f.n[key] >= max {
		return false
	}
	f.n[key]++
	return true
}

func (f *inflight) release(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n[key]--; f.n[key] <= 0 {
		delete(f.n, key)
	}
}

// agentLimits applies the per-address limits. A refused hit is not recorded, so a flood cannot extend its own block.
func (s *Server) agentLimits(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, now := limitKey(agentClient(r.Context())), s.Clock.Now()
		if d := s.agentFailLimit.RetryAfter(key, now); d > 0 {
			retryAfter(w, d)
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many failed tries. Wait a while.")
			return
		}
		if !s.agentInflight.acquire(key, agentInflightPerIP) {
			w.Header().Set("Retry-After", "5")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many requests at once.")
			return
		}
		defer s.agentInflight.release(key)
		switch p := r.URL.Path; {
		case r.Method == http.MethodPost && p == "/api/device/code":
			if !s.agentStartLimit.Allow(key, now) || !s.agentStartAll.Allow("all", now) {
				w.Header().Set("Retry-After", "3600")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many login requests. Try again later.")
				return
			}
		case r.Method == http.MethodPost && p == "/api/device/token":
			if !s.agentPollLimit.Allow(key, now) {
				w.Header().Set("Retry-After", "60")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute.")
				return
			}
		case p == "/install" || strings.HasPrefix(p, "/cli/"):
			if !s.agentDownloadLimit.Allow(key, now) {
				w.Header().Set("Retry-After", "3600")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many downloads from this address. Try again later.")
				return
			}
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status == http.StatusUnauthorized && !sw.notAGuess {
			s.agentFailLimit.Allow(key, now)
		}
	})
}

// notAGuess tells agentLimits that a 401 is not a wrong guess: the caller held a real credential that has ended (session_ended).
func notAGuess(w http.ResponseWriter) {
	for w != nil {
		if sw, ok := w.(*statusWriter); ok {
			sw.notAGuess = true
			return
		}
		u, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return
		}
		w = u.Unwrap()
	}
}

// clearReadDeadline drops the connection's read deadline once the request is read: at once for a request with no body, at the end of
// the body for one with a body. The deadline then only bounds reading, so a long poll (GET /api/inbox?wait) and an event stream live on.
func clearReadDeadline(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		if r.Body == nil || r.Body == http.NoBody {
			_ = rc.SetReadDeadline(time.Time{})
		} else {
			r.Body = &deadlineBody{ReadCloser: r.Body, rc: rc}
		}
		next.ServeHTTP(w, r)
	})
}

type deadlineBody struct {
	io.ReadCloser
	rc   *http.ResponseController
	done bool
}

func (b *deadlineBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF && !b.done {
		b.done = true
		_ = b.rc.SetReadDeadline(time.Time{})
	}
	return n, err
}

// LimitConns caps the open connections of a listener: a slot is held until the connection closes.
func LimitConns(ln net.Listener, max int) net.Listener {
	return &limitListener{Listener: ln, slots: make(chan struct{}, max)}
}

type limitListener struct {
	net.Listener
	slots chan struct{}
}

func (l *limitListener) Accept() (net.Conn, error) {
	l.slots <- struct{}{}
	c, err := l.Listener.Accept()
	if err != nil {
		<-l.slots
		return nil, err
	}
	return &limitConn{Conn: c, release: func() { <-l.slots }}, nil
}

type limitConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}
