package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// mintSession is POST /api/sessions: the one route a machine key opens.
func (s *Server) mintSession(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.MintRequest
	if !decode(w, r, &in) {
		return
	}
	req := auth.MintRequest{MachineKey: c.token, As: in.As, ClientID: in.ClientID, Label: in.Label, ViaInternet: agentClient(r.Context()) != ""}
	if in.Create != nil {
		avatar, ok := cleanAvatar(w, in.Create.AvatarSVG)
		if !ok {
			return
		}
		req.Create = &auth.CreateIdentity{
			DisplayName: in.Create.DisplayName, Description: in.Create.Description, AvatarSVG: avatar,
			ConversationID: in.Create.ConversationID, Request: in.Create.Request, Invite: in.Create.Invite,
		}
	}
	var minted auth.MintedSession
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		now := s.Clock.Now()
		var err error
		if minted, err = auth.MintSession(ctx, tx.DBTX(), flowPorts, req, now); err != nil || minted.Waiting != nil {
			return err
		}
		// The new lease takes over the claims of the one it replaces: the agent is still on the same work (M5).
		return inbox.Transfer(ctx, tx.DBTX(), now, minted.Replaced, minted.ID)
	})
	var limited *auth.RateLimitedError
	var forbidden auth.ForbiddenError
	var invalid *auth.FieldError
	var renamed *auth.HandleRenamedError
	switch {
	case errors.As(err, &renamed):
		writeErr(w, http.StatusForbidden, wire.CodeHandleRenamed, renamed.Error())
	case errors.Is(err, auth.ErrMachineGone):
		unauthorized(w)
	case errors.Is(err, auth.ErrNoIdentityRequest):
		writeErr(w, http.StatusNotFound, "not_found", "No such request.")
	case errors.Is(err, auth.ErrIdentityDenied):
		writeErr(w, http.StatusForbidden, wire.CodeRequestDenied, "The owner denied the request.")
	case errors.Is(err, auth.ErrIdentityExpired):
		writeErr(w, http.StatusGone, wire.CodeRequestExpired, "The request expired. Ask again.")
	case errors.As(err, &forbidden):
		writeErr(w, http.StatusForbidden, "forbidden", forbidden.Error())
	case errors.Is(err, auth.ErrInviteSpent):
		writeErr(w, http.StatusBadRequest, wire.CodeInviteSpent, inviteSpentMessage)
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
		writeFieldErr(w, http.StatusConflict, wire.CodeHandleTaken, "as", "That handle is taken or was used before. Ask the owner to allow it on this machine.")
	case err != nil:
		s.internalError(w, r, err)
	case minted.Waiting != nil:
		s.Bus.Notify()
		writeJSON(w, http.StatusAccepted, wire.MintPending{Request: wire.IdentityRequestState{Ref: minted.Waiting.Ref, State: auth.StatePending, ExpiresAt: minted.Waiting.ExpiresAt, IntervalMs: s.interval().Milliseconds()}})
	default:
		out := wire.MintResponse{Lease: minted.Lease, Session: wire.SessionInfo{
			ID: minted.ID, Identity: minted.Handle, IdentityID: minted.IdentityID, Machine: minted.Machine, ClientID: minted.ClientID, Label: minted.Label, ExpiresAt: minted.ExpiresAt,
		}}
		if rn := minted.Renamed; rn != nil {
			out.Renamed = &wire.Renamed{From: rn.From, To: rn.To, Until: rn.Until}
		}
		writeJSON(w, http.StatusCreated, out)
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
	if p, found, err := identity.ProfileOf(ctx, s.reader(), who.ID); err != nil {
		s.internalError(w, r, err)
		return
	} else if found {
		out.Identity.Description, out.Identity.Capabilities = p.Description, p.Capabilities
	}
	retired, err := identity.RetiredOf(ctx, s.reader(), who.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	now := s.Clock.Now()
	for _, h := range retired {
		until := time.UnixMilli(h.RetiredAt).Add(identity.HandleGrace)
		out.Identity.PreviousHandles = append(out.Identity.PreviousHandles, wire.PreviousHandle{Handle: h.Handle, Until: until.UnixMilli(), Works: now.Before(until)})
	}
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
	var (
		expires int64
		holds   []inbox.Hold
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		now := s.Clock.Now()
		if expires, err = auth.SlideLease(ctx, tx.DBTX(), c.lease, now); err != nil {
			return err
		}
		holds, err = inbox.Extend(ctx, tx.DBTX(), now, c.lease.SessionID, expires)
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, h := range holds { // the claims now run longer, so the "working" of each ends later
		s.publishHold(r.Context(), c.lease.IdentityID, h)
	}
	writeJSON(w, http.StatusOK, map[string]any{"expires_at": expires})
}

// publishReleased tells the feeds that the agents of released claims stopped working. It runs after the commit.
func (s *Server) publishReleased(ctx context.Context, released []inbox.Released) {
	identities := make([]int64, 0, len(released))
	for _, r := range released {
		s.publishWorking(ctx, r.Identity, r.Conversation, false, 0)
		identities = append(identities, r.Identity)
	}
	// Ending leases ends the polls held on them: wake the polls so each looks at its lease (I-38).
	s.Bus.Notify(identities...)
}

func (s *Server) endSession(w http.ResponseWriter, r *http.Request, c *call) {
	now := s.Clock.Now()
	var released []int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		if err := auth.EndOwnLease(ctx, tx.DBTX(), journalPort{}, c.lease, now); err != nil {
			return err
		}
		var err error
		released, err = inbox.Release(ctx, tx.DBTX(), now, c.lease.SessionID)
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, conv := range released {
		s.publishWorking(r.Context(), c.lease.IdentityID, conv, false, 0)
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

// releaseEnded is the release every path that ends a lease runs in its transaction (I-38): the inbox claims of the ended
// sessions let go.
func releaseEnded(ctx context.Context, d pdb.DBTX, now time.Time, ended []int64) ([]inbox.Released, error) {
	return inbox.ReleaseSessions(ctx, d, now, ended)
}
