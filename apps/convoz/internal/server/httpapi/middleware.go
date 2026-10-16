package httpapi

import (
	"mime"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DeviceCookie is the device session cookie. The __Host- prefix makes browsers insist on Secure,
// Path=/ and no Domain.
const DeviceCookie = "__Host-convoz_sid"

// credentialInURL matches a Convoz token (cvz_<letter>_) anywhere in a query string.
var credentialInURL = regexp.MustCompile(`cvz_[a-z]_`)

// chain wraps the route table in the wall, in this order (design I-41):
// Host (421) -> funnel (403) -> credential in the query (400) -> strip untrusted headers ->
// CSRF -> machine credential (401). Authentication and the route's own requirements run per route.
func (s *Server) chain(next http.Handler) http.Handler {
	h := rejectForeignCredential(next)
	h = s.csrf(h)
	h = s.stripUntrusted(h)
	h = rejectCredentialInURL(h)
	h = s.rejectFunnel(h)
	h = s.checkHost(h)
	h = securityHeaders(h)
	return s.logRequests(h)
}

// securityHeaders is what every answer carries: no type sniffing, no referrer.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// checkHost refuses any Host that is not ours, before auth. Over TCP the Host header is the name (with
// the bound port); behind `tailscale serve` on the unix socket the Host stays "localhost" and the name
// arrives in X-Forwarded-Host, which only the serve peer can reach (the socket is mode 0600).
func (s *Server) checkHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hostOK(r) {
			writeErr(w, http.StatusMisdirectedRequest, "misdirected", "This server does not answer to that name.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) hostOK(r *http.Request) bool {
	host := strings.ToLower(r.Host)
	name := strings.ToLower(s.Cfg.Host)
	if s.Cfg.Unix {
		return host == "localhost" && forwardedHostOK(strings.ToLower(r.Header.Get("X-Forwarded-Host")), name, s.Cfg.PublicPort)
	}
	return host == name || host == net.JoinHostPort(name, strconv.Itoa(s.Cfg.Port))
}

// forwardedHostOK accepts the configured name as the client typed it: with the serve port when `tailscale serve`
// listens on a non-443 port (publicPort), without one (or with :443) otherwise. Any other port is a different listener.
func forwardedHostOK(forwarded, name string, publicPort int) bool {
	if forwarded == name {
		return publicPort == 0
	}
	h, p, err := net.SplitHostPort(forwarded)
	if err != nil || h != name {
		return false
	}
	if publicPort == 0 {
		return p == "443"
	}
	return p == strconv.Itoa(publicPort)
}

// rejectFunnel refuses anything Tailscale marks as coming through funnel, whatever the start check said.
func (s *Server) rejectFunnel(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Tailscale-Funnel-Request") != "" {
			writeErr(w, http.StatusForbidden, "funnel", "Funnel requests are refused.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rejectCredentialInURL refuses a token in the query string. The URL is never logged either.
func rejectCredentialInURL(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if credentialInURL.MatchString(r.URL.RawQuery) {
			writeErr(w, http.StatusBadRequest, "credential_in_url", "Send credentials in a header or the body, never in the URL.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// stripUntrusted drops forwarding and Tailscale headers unless the peer is the serve socket.
// On TCP anyone on loopback can write them, so they are never an input.
func (s *Server) stripUntrusted(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.Cfg.Unix {
			for name := range r.Header {
				l := strings.ToLower(name)
				if strings.HasPrefix(l, "x-forwarded-") || strings.HasPrefix(l, "tailscale-") || l == "forwarded" || l == "x-real-ip" {
					r.Header.Del(name)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// csrf guards every write under /api: the exact Origin (a missing one is refused), the Convoz header and a
// JSON body type. A request with an Authorization header is not cookie-borne and is judged by its credential.
// The routes marked NoCSRF (the device flow: a CLI with no cookie and no credential) are the only other exception.
func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Authorization") == "" && !s.csrfExempt[r.Method+" "+r.URL.Path] {
			media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if r.Header.Get("Origin") != s.Cfg.Origin || r.Header.Get("X-Convoz") != "1" || media != "application/json" {
				writeErr(w, http.StatusForbidden, "csrf", "This request did not come from the Convoz app.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// logRequests writes one line per request: method, path, status, duration. Never the query, a header or a body.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.Clock.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if v := recover(); v != nil {
				s.Log.Printf("panic serving %s %s", r.Method, loggablePath(r))
				if sw.status == http.StatusOK {
					writeErr(sw, http.StatusInternalServerError, "internal", "Something went wrong on the server.")
				}
			}
			s.Log.Printf("%s %s %d %dms", r.Method, loggablePath(r), sw.status, s.Clock.Now().Sub(start)/time.Millisecond)
		}()
		next.ServeHTTP(sw, r)
	})
}

// loggablePath is the path with any token-looking text removed.
func loggablePath(r *http.Request) string {
	if strings.Contains(r.URL.Path, "cvz_") {
		return "[redacted]"
	}
	return r.URL.Path
}
