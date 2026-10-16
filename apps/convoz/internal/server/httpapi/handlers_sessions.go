package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// createdPerDay is how many identities one machine may make in 24 hours.
const createdPerDay = 5

// validClientID is 8 to 64 printable characters.
func validClientID(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 8 && n <= 64 && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}

func validLabel(s string) bool {
	return utf8.RuneCountInString(s) <= 80 && !strings.ContainsFunc(s, unicode.IsControl)
}

// errForbidden carries the sentence for a 403 raised inside a transaction.
type errForbidden string

func (e errForbidden) Error() string { return string(e) }

// errFieldInvalid is a 400 about one field, raised inside a transaction.
type errFieldInvalid struct{ field, message string }

func (e errFieldInvalid) Error() string { return e.message }

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
	now := s.Clock.Now()
	var minted auth.MintedSession
	var handle string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		// The machine is read again inside the transaction: a revoke or a new allow-list may have landed since the request began.
		machine, ok, err := auth.MachineByKey(ctx, d, c.token)
		if err != nil {
			return err
		}
		if !ok {
			return errMachineGone
		}
		who, err := s.sessionIdentity(ctx, d, machine, in, now)
		if err != nil {
			return err
		}
		handle = who.Handle
		minted, err = auth.MintSession(ctx, d, auth.MintInput{Machine: machine, IdentityID: who.ID, Handle: who.Handle, ClientID: in.ClientID, Label: in.Label}, now)
		if err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: who.ID, Machine: machine.ID, Session: minted.ID, Action: "session.started", TargetKind: "session", TargetID: minted.ID}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "session.started", map[string]any{"session_id": minted.ID, "machine_id": machine.ID, "identity_id": who.ID})
		return err
	})
	var limited *auth.RateLimitedError
	var forbidden errForbidden
	var invalid errFieldInvalid
	switch {
	case errors.Is(err, errMachineGone):
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
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.field, invalid.message)
	case errors.Is(err, errHandleTaken):
		writeFieldErr(w, http.StatusConflict, "handle_taken", "as", "That handle was used before and cannot be made again.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusCreated, wire.MintResponse{Lease: minted.Lease, Session: wire.SessionInfo{
			ID: minted.ID, Identity: handle, Machine: minted.Machine, ClientID: minted.ClientID, Label: minted.Label, ExpiresAt: minted.ExpiresAt,
		}})
	}
}

var errMachineGone = errors.New("the machine key stopped working")

// sessionIdentity finds the agent a mint is for, or makes it when the machine may. A human, a disabled
// identity and a handle the machine may not use are all 403; so is "create" without the scope.
func (s *Server) sessionIdentity(ctx context.Context, d pdb.DBTX, m auth.Machine, in wire.MintRequest, now time.Time) (identity.Principal, error) {
	if in.Create != nil && m.Scopes&auth.ScopeCreateIdentity == 0 {
		return identity.Principal{}, errForbidden("This machine may not make identities.")
	}
	handle := strings.ToLower(in.As)
	who, found, err := identity.Lookup(ctx, d, handle)
	if err != nil {
		return identity.Principal{}, err
	}
	if !found {
		if in.Create == nil || !m.Allow.CoversHandle(handle) {
			return identity.Principal{}, errForbidden("This machine may not act as that identity.")
		}
		return s.createForMachine(ctx, d, m, handle, in.Create.DisplayName, now)
	}
	if who.Kind != "agent" || who.Disabled {
		return identity.Principal{}, errForbidden("That identity cannot start a session.")
	}
	return who, nil
}

func (s *Server) createForMachine(ctx context.Context, d pdb.DBTX, m auth.Machine, handle, displayName string, now time.Time) (identity.Principal, error) {
	n, oldest, err := identity.CreatedByMachineSince(ctx, d, m.ID, now.Add(-24*time.Hour))
	if err != nil {
		return identity.Principal{}, err
	}
	if n >= createdPerDay {
		return identity.Principal{}, &auth.RateLimitedError{RetryAfter: max(time.Second, time.UnixMilli(oldest).Add(24*time.Hour).Sub(now))}
	}
	who, err := identity.CreateAgent(ctx, d, identity.NewAgent{Handle: handle, DisplayName: displayName, ByMachine: m.ID}, now)
	if err != nil {
		return identity.Principal{}, agentError(err)
	}
	if err := audit.Write(ctx, d, now, audit.Entry{Machine: m.ID, Action: "identity.created", TargetKind: "identity", TargetID: who.ID}); err != nil {
		return identity.Principal{}, err
	}
	_, err = event.Append(ctx, d, now, "identity.created", map[string]any{"identity_id": who.ID, "machine_id": m.ID})
	return who, err
}

// agentError turns a CreateAgent refusal into the 4xx that names the field; other errors pass through.
func agentError(err error) error {
	switch {
	case errors.Is(err, identity.ErrInvalidHandle):
		return errFieldInvalid{"handle", "A handle has 2 to 40 characters from a-z, 0-9 and -, starts with a letter and is not reserved."}
	case errors.Is(err, identity.ErrHandleTaken):
		return errHandleTaken
	case errors.Is(err, identity.ErrInvalidDisplayName):
		return errFieldInvalid{"display_name", "A display name has 1 to 80 characters."}
	case errors.Is(err, identity.ErrConfusableName):
		return errFieldInvalid{"display_name", "That name looks like another identity's name. Pick a different one."}
	}
	return err
}

var errHandleTaken = errors.New("handle taken")

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
		expires, err = auth.SlideLease(ctx, tx.DBTX(), c.lease, s.Clock.Now())
		return err
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
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.lease.IdentityID, Machine: c.lease.MachineID, Session: c.lease.SessionID, Action: "session.ended", TargetKind: "session", TargetID: c.lease.SessionID, Detail: map[string]any{"reason": "logout"}})
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
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
