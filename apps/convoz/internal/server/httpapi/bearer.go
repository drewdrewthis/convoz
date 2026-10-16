package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// errAnswered means authentication already wrote the response (a 401).
var errAnswered = errors.New("answered")

// bearerToken is the token of an "Authorization: Bearer <token>" header; empty for any other form.
func bearerToken(header string) string {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

func unauthorized(w http.ResponseWriter) {
	writeErr(w, http.StatusUnauthorized, "unauthorized", "That credential is not valid.")
}

// authenticateBearer reads a machine key or a session lease. A cookie that comes with it is ignored: an
// Authorization header means the caller is a program, and a program has no ambient authority to borrow.
func (s *Server) authenticateBearer(w http.ResponseWriter, r *http.Request, header string) (*call, error) {
	token := bearerToken(header)
	switch {
	case strings.HasPrefix(token, auth.PrefixSession):
		return s.authenticateLease(w, r, token)
	case strings.HasPrefix(token, auth.PrefixMachine):
		m, ok, err := auth.MachineByKey(r.Context(), s.reader(), token)
		if err != nil {
			return nil, err
		}
		if !ok {
			unauthorized(w)
			return nil, errAnswered
		}
		return &call{token: token, machine: m, p: authz.Principal{MachineID: m.ID}}, nil
	}
	unauthorized(w)
	return nil, errAnswered
}

func (s *Server) authenticateLease(w http.ResponseWriter, r *http.Request, token string) (*call, error) {
	ctx, now := r.Context(), s.Clock.Now()
	l, dead, ok, err := auth.LookupLease(ctx, s.reader(), token, now)
	if err != nil {
		return nil, err
	}
	switch {
	case dead != nil:
		writeErr(w, http.StatusUnauthorized, "session_ended", sessionEndedMessage(dead.Reason))
		return nil, errAnswered
	case !ok:
		unauthorized(w)
		return nil, errAnswered
	}
	if l.NeedsSlide(now) {
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			_, err := auth.SlideLease(ctx, tx.DBTX(), l, now)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	return &call{token: token, lease: l, p: authz.Principal{SessionID: l.SessionID}}, nil
}

// sessionEndedMessage says why a lease no longer works, in words for the person running the agent.
func sessionEndedMessage(reason string) string {
	switch reason {
	case "identity_disabled":
		return "The identity was disabled by the owner."
	case "machine_revoked":
		return "The machine was revoked by the owner."
	case "key_regenerated":
		return "The machine key was regenerated. Start a new session."
	case "allow_removed":
		return "The owner removed this identity from the machine."
	case "replaced":
		return "A newer session with the same client id replaced this one."
	case "logout":
		return "The session was ended."
	}
	return "The session expired. Start a new one."
}

// rejectForeignCredential is the check before routing: a machine key works on POST /api/sessions and nowhere
// else, and any other Authorization header is not a Convoz credential at all.
func rejectForeignCredential(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if header := r.Header.Get("Authorization"); header != "" {
			token := bearerToken(header)
			mintsHere := r.Method == http.MethodPost && r.URL.Path == "/api/sessions"
			switch {
			case strings.HasPrefix(token, auth.PrefixSession):
			case strings.HasPrefix(token, auth.PrefixMachine) && mintsHere:
			default:
				unauthorized(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
