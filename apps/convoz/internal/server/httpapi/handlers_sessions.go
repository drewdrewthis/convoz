package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// validClientID is 8 to 64 printable characters.
func validClientID(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 8 && n <= 64 && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}

func validLabel(s string) bool {
	return utf8.RuneCountInString(s) <= 80 && !strings.ContainsFunc(s, unicode.IsControl)
}

// mintSession is POST /api/sessions: the one route a machine key opens.
func (s *Server) mintSession(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.MintRequest
	if !decode(w, r, &in) {
		return
	}
	switch {
	case !identity.ValidHandle(strings.ToLower(in.As)):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "as", "The identity must be a handle.")
		return
	case !validClientID(in.ClientID):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	case !validLabel(in.Label):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "label", "The label can have at most 80 characters.")
		return
	}
	req := auth.MintRequest{MachineKey: c.token, As: in.As, ClientID: in.ClientID, Label: in.Label}
	if in.Create != nil {
		req.Create = &auth.CreateIdentity{DisplayName: in.Create.DisplayName}
	}
	var minted auth.MintedSession
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		minted, err = auth.MintSession(ctx, tx.DBTX(), flowPorts, req, s.Clock.Now())
		return err
	})
	var limited *auth.RateLimitedError
	var forbidden auth.ForbiddenError
	var invalid *auth.FieldError
	switch {
	case errors.Is(err, auth.ErrMachineGone):
		unauthorized(w)
	case errors.As(err, &forbidden):
		writeErr(w, http.StatusForbidden, "forbidden", forbidden.Error())
	case errors.Is(err, auth.ErrNotAllowed):
		writeErr(w, http.StatusForbidden, "forbidden", "This machine may not act as that identity.")
	case errors.Is(err, auth.ErrSessionCap):
		writeErr(w, http.StatusTooManyRequests, "session_cap", "Too many live sessions. End one first.")
	case errors.As(err, &limited):
		retryAfter(w, limited.RetryAfter)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many sessions were started. Try again later.")
	case errors.As(err, &invalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.Field, invalid.Message)
	case errors.Is(err, auth.ErrHandleTaken):
		writeFieldErr(w, http.StatusConflict, "handle_taken", "as", "That handle was used before and cannot be made again.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusCreated, wire.MintResponse{Lease: minted.Lease, Session: wire.SessionInfo{
			ID: minted.ID, Identity: minted.Handle, Machine: minted.Machine, ClientID: minted.ClientID, Label: minted.Label, ExpiresAt: minted.ExpiresAt,
		}})
	}
}

// leaseMe is GET /api/me for an agent lease.
func (s *Server) leaseMe(w http.ResponseWriter, r *http.Request, c *call) {
	ctx := r.Context()
	who, found, err := identity.ByID(ctx, s.reader(), c.lease.IdentityID)
	if err != nil || !found {
		s.internalError(w, r, errors.Join(err, errors.New("lease without identity")))
		return
	}
	live, err := auth.LiveSessionCount(ctx, s.reader(), who.ID, s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var out wire.MeResponse
	out.Identity.ID, out.Identity.Handle, out.Identity.DisplayName, out.Identity.Kind = who.ID, who.Handle, who.DisplayName, "agent"
	out.Machine.ID, out.Machine.Name = c.lease.MachineID, c.lease.Machine
	out.Session.ID, out.Session.ClientID, out.Session.Label, out.Session.ExpiresAt = c.lease.SessionID, c.lease.ClientID, c.lease.Label, c.lease.ExpiresAt
	out.Scopes, out.LiveSessions = auth.ScopeNames(c.lease.Scopes), live
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) renewSession(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var expires int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		now := s.Clock.Now()
		if expires, err = auth.SlideLease(ctx, tx.DBTX(), c.lease, now); err != nil {
			return err
		}
		return inbox.Extend(ctx, tx.DBTX(), now, c.lease.SessionID, expires)
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"expires_at": expires})
}

func (s *Server) endSession(w http.ResponseWriter, r *http.Request, c *call) {
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, err := auth.EndLease(ctx, d, c.lease.SessionID, "logout", now); err != nil {
			return err
		}
		if err := inbox.Release(ctx, d, now, c.lease.SessionID); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.lease.IdentityID, Machine: c.lease.MachineID, Session: c.lease.SessionID, Action: "session.ended", TargetKind: "session", TargetID: c.lease.SessionID, Detail: map[string]any{"reason": "logout"}})
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify(c.lease.IdentityID) // a poll held for this lease answers "session ended" at once
	w.WriteHeader(http.StatusNoContent)
}

// maxSessionsListed bounds GET /api/sessions.
const maxSessionsListed = 200

type sessionJSON struct {
	ID         int64   `json:"id"`
	Identity   string  `json:"identity"`
	Machine    string  `json:"machine"`
	ClientID   string  `json:"client_id"`
	Label      string  `json:"label"`
	State      string  `json:"state"`
	EndReason  *string `json:"end_reason"`
	LastSeenAt int64   `json:"last_seen_at"`
	ExpiresAt  int64   `json:"expires_at"`
}

func (s *Server) sessions(w http.ResponseWriter, r *http.Request, _ *call) {
	ctx := r.Context()
	list, err := auth.ListSessions(ctx, s.reader(), maxSessionsListed, s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	handles, err := identity.Handles(ctx, s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]sessionJSON, 0, len(list))
	for _, x := range list {
		row := sessionJSON{ID: x.ID, Identity: handles[x.IdentityID], Machine: x.Machine, ClientID: x.ClientID, Label: x.Label, State: "ended", LastSeenAt: x.LastSeenAt, ExpiresAt: x.ExpiresAt}
		if x.Live {
			row.State = "live"
		} else {
			reason := x.EndReason
			row.EndReason = &reason
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}
