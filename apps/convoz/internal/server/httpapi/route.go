package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// call is what a handler knows about its caller.
type call struct {
	p       authz.Principal
	dev     auth.Device
	human   auth.Human
	token   string // the device cookie value, or the machine key; empty when anonymous
	stepUp  int64  // X-Convoz-Step-Up as a number; 0 when absent
	machine auth.Machine
	lease   auth.Lease
}

// source names who is calling for rate limits. Over TCP it is the peer address; behind the serve socket it is
// the last X-Forwarded-For entry, which `tailscale serve` writes. Never an auth input.
func (s *Server) source(r *http.Request) string {
	if s.Cfg.Unix {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
		return "unix"
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// route wraps one table row: public rate limit, authentication, the Auth class, and the step-up header check.
func (s *Server) route(rt Route) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		now := s.Clock.Now()
		if rt.Auth == authz.Pub && rt.Method == http.MethodPost && !rt.NoLimit && !s.publicLimit.Allow(s.source(r)+"|"+rt.Pattern, now) {
			w.Header().Set("Retry-After", "60")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute.")
			return
		}
		c := &call{}
		if rt.Auth != authz.Pub {
			var err error
			if c, err = s.authenticate(w, r); errors.Is(err, errAnswered) {
				return
			} else if err != nil {
				s.internalError(w, r, err)
				return
			}
			if c.p.SessionID != 0 && rt.RefuseLease {
				writeErr(w, http.StatusForbidden, "forbidden", "An agent credential cannot do this.")
				return
			}
			if err := rt.check(c.p); err != nil {
				s.deny(w, r, rt, err)
				return
			}
			if c.p.SessionID != 0 && !leaseHas(c.lease, rt.Scope) {
				writeErr(w, http.StatusForbidden, "forbidden", scopeRefusals[rt.Scope])
				return
			}
			if rt.StepUp != "" && !c.p.Limited {
				id, perr := strconv.ParseInt(r.Header.Get("X-Convoz-Step-Up"), 10, 64)
				if perr != nil || id <= 0 {
					writeErr(w, http.StatusForbidden, "step_up_required", "This needs a fresh passkey check.")
					return
				}
				c.stepUp = id
			}
		}
		rt.handle(s, w, r, c)
	}
}

// deny answers a failed Auth check: a page redirects, the API says 401 or 403.
func (s *Server) deny(w http.ResponseWriter, r *http.Request, rt Route, err error) {
	if rt.Page {
		to := "/signin"
		if r.URL.Path != "/" {
			to += "?next=" + url.QueryEscape(r.URL.RequestURI()) // the sign-in page sends the owner back here
		}
		if errors.Is(err, authz.ErrLimited) {
			to = "/recover"
		}
		http.Redirect(w, r, to, http.StatusFound)
		return
	}
	switch {
	case errors.Is(err, authz.ErrUnauthorized):
		writeErr(w, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
	case errors.Is(err, authz.ErrLimited):
		writeErr(w, http.StatusForbidden, "limited_device", "This device may only add a passkey.")
	default:
		writeErr(w, http.StatusForbidden, "forbidden", "You are not allowed to do this.")
	}
}

// authenticate reads the device cookie. An unknown, expired or revoked cookie is anonymous, not an error.
// Use of a live session is written at most once a minute, and the cookie is re-issued then so its
// Max-Age slides with the session.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (*call, error) {
	if header := r.Header.Get("Authorization"); header != "" {
		return s.authenticateBearer(w, r, header)
	}
	c := &call{}
	cookie, err := r.Cookie(DeviceCookie)
	if err != nil || cookie.Value == "" {
		return c, nil
	}
	ctx := r.Context()
	now := s.Clock.Now()
	dev, ok, err := auth.LookupDevice(ctx, s.reader(), cookie.Value, now)
	if err != nil || !ok {
		return c, err
	}
	h, err := identity.Get(ctx, s.reader(), dev.HumanID)
	if err != nil {
		return c, err
	}
	if dev.NeedsSlide(now) {
		var left int
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			var err error
			left, err = auth.SlideDevice(ctx, tx.DBTX(), dev, now)
			return err
		})
		if err != nil {
			return c, err
		}
		setDeviceCookie(w, cookie.Value, left)
	}
	c.p = authz.Principal{Authenticated: true, HumanID: h.ID, DeviceID: dev.ID, Limited: dev.Limited, Role: h.Role}
	c.dev = dev
	c.human = auth.Human{ID: h.ID, Handle: h.Handle, DisplayName: h.DisplayName, Role: h.Role}
	c.token = cookie.Value
	return c, nil
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.Log.Printf("internal error on %s %s: %v", r.Method, loggablePath(r), err)
	writeErr(w, http.StatusInternalServerError, "internal", "Something went wrong on the server.")
}

// setDeviceCookie sets the strict device cookie. Max-Age only: an Expires date would trust the client clock.
func setDeviceCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: DeviceCookie, Value: token, Path: "/", MaxAge: maxAge,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
}

// clearDeviceCookie expires the cookie (Max-Age=0).
func clearDeviceCookie(w http.ResponseWriter) { setDeviceCookie(w, "", -1) }

// scopeRefusals is what a lease is told when its machine lacks the scope a route needs (I-6). The route table names the scope and
// route() checks it before the body is read, so no handler repeats the check and none can forget it.
var scopeRefusals = map[string]string{
	"post":   "This machine may not post.",
	"ask":    "This machine may not ask.",
	"status": "This machine may not report a status.",
	"upload": "This machine may not upload.",
	"read":   "This machine may not read.",
}

// leaseHas reports whether the lease holds scope; a route that needs none ("") is open to every lease.
func leaseHas(l auth.Lease, scope string) bool {
	if scope == "" {
		return true
	}
	mask, _ := auth.ScopeMask([]string{scope})
	return l.Scopes&mask != 0
}
