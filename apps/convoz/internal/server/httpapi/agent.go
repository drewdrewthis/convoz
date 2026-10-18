package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
)

// The agent listener is a second, agents-only door (design §3.4a): the one `tailscale funnel` points at. It serves the
// routes Route.AgentReason allows and answers 404 to every other path. The list is derived from the route table and is
// an allow-list: a route that says nothing is refused.

// viaInternet marks a device request that came in on the agent listener. It prefixes the stored source, so the owner's
// card can say "via internet" without a new column; per-source limits still count the bare address after the prefix.
const viaInternet = "internet:"

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
	return s.identifyAgent(h)
}

// identifyAgent fixes who is calling and removes what must not count here. The cookie goes first: an owner session
// cookie gives no rights on this listener. Forwarding headers are read once, then dropped.
func (s *Server) identifyAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
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

// clientIP is the peer address, unless the peer is the local tailscale proxy (loopback) and wrote a valid
// X-Forwarded-For: then it is the last entry, the one the proxy added. Anyone else's header is not an input.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if peer, err := netip.ParseAddr(host); err == nil && peer.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				return ip.String()
			}
		}
	}
	return host
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
	if host == name || host == net.JoinHostPort(name, strconv.Itoa(s.Cfg.AgentPort)) {
		return true
	}
	public := s.Cfg.AgentPublicPort
	if public == 0 {
		public = 443
	}
	return host == net.JoinHostPort(name, strconv.Itoa(public))
}

// Limits of the internet-facing door, per client address. They come on top of the per-machine caps.
const (
	agentStartsPerHour = 10 // POST /api/device/code
	agentPollsPerMin   = 60 // POST /api/device/token; a CLI polls every 5 s
	agentFailsPer10Min = 30 // answers of 401: a guess at a credential
	agentFailWindow    = 10 * time.Minute
)

// agentLimits applies the per-address limits. A refused hit is not recorded, so a flood cannot extend its own block.
func (s *Server) agentLimits(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, now := agentClient(r.Context()), s.Clock.Now()
		if d := s.agentFailLimit.RetryAfter(ip, now); d > 0 {
			retryAfter(w, d)
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many failed tries. Wait a while.")
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /api/device/code":
			if !s.agentStartLimit.Allow(ip, now) {
				w.Header().Set("Retry-After", "3600")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many login requests from this address. Try again later.")
				return
			}
		case "POST /api/device/token":
			if !s.agentPollLimit.Allow(ip, now) {
				w.Header().Set("Retry-After", "60")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute.")
				return
			}
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status == http.StatusUnauthorized {
			s.agentFailLimit.Allow(ip, now)
		}
	})
}
