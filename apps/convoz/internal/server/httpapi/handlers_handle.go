package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// An agent's handle can change (I-51): the owner changes it in Crew, or the agent asks and the owner approves with one tap in Now.
// Owner (2026-10-18): "Handles I think can also change, that seems fine because there's an id, right?"

// Event names of a handle change. Thin: ids only (I-23).
const (
	eventHandleRequested = "identity.handle_requested.v1"
	eventHandleChanged   = "identity.handle_changed.v1"
)

// renamedBy is who makes a change: the owner deciding it, with the device the tap came from.
type renamedBy struct{ Human, Device int64 }

// renameAgent changes an agent's handle from → to with everything that goes with it, in the caller's transaction: the machines that
// may act as it stay the same, the handle moves (the triggers retire the old one at once), every conversation the agent is in says
// "@from is now @to", and the audit row keeps both handles.
func renameAgent(ctx context.Context, d pdb.DBTX, now time.Time, by renamedBy, agentID int64, from, to string) error {
	if _, err := identity.CheckHandleChange(ctx, d, agentID, to, now); err != nil {
		return err
	}
	if err := auth.KeepAllowOnRename(ctx, d, agentID, from, to, now); err != nil {
		return err
	}
	if err := identity.ChangeHandle(ctx, d, agentID, from, to, now); err != nil {
		return err
	}
	convs, err := conversation.ListOf(ctx, d, agentID)
	if err != nil {
		return err
	}
	for _, cv := range convs {
		if _, _, err := sayLine(ctx, d, now, by.Human, cv.ID, message.SystemLine{T: "member.renamed", Identity: agentID, From: from, To: to}); err != nil {
			return err
		}
	}
	if err := audit.Write(ctx, d, now, audit.Entry{Actor: by.Human, Device: by.Device, Action: "identity.handle_changed", TargetKind: "identity", TargetID: agentID,
		Detail: map[string]any{"from": from, "to": to}}); err != nil {
		return err
	}
	_, err = event.Append(ctx, d, now, eventHandleChanged, map[string]any{"identity_id": agentID})
	return err
}

// handleOf reads a handle the way a person types it: "@Dev-CI " is "dev-ci".
func handleOf(s string) string { return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "@")) }

// handleRefused answers the refusals of a handle change and reports whether err was one.
func handleRefused(w http.ResponseWriter, err error) bool {
	var limited *identity.HandleRateLimited
	var field *auth.FieldError
	switch {
	case errors.As(err, &limited):
		retryAfter(w, limited.RetryAfter)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "A handle changes once in 30 days.")
	case errors.Is(err, identity.ErrInvalidHandle):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "handle", "A handle has 2 to 40 characters from a-z, 0-9 and -, starts with a letter and is not reserved.")
	case errors.Is(err, identity.ErrHandleTaken):
		writeFieldErr(w, http.StatusConflict, wire.CodeHandleTaken, "handle", "That handle is taken or was used before.")
	case errors.Is(err, identity.ErrConfusableHandle):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "handle", "That handle looks like another identity's name. Pick a different one.")
	case errors.As(err, &field):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", field.Field, field.Message)
	case errors.Is(err, identity.ErrNotRenamable):
		writeErr(w, http.StatusBadRequest, "invalid_request", "Only an enabled agent's handle changes.")
	case errors.Is(err, identity.ErrNotAgent):
		writeErr(w, http.StatusNotFound, "not_found", "No such agent.")
	case errors.Is(err, identity.ErrHandleChanged):
		writeErr(w, http.StatusConflict, "conflict", "The handle changed meanwhile. Look again.")
	default:
		return false
	}
	return true
}

func handleChanged(id int64, from, to string) wire.HandleChanged {
	var out wire.HandleChanged
	out.Identity.ID, out.Identity.Handle, out.Identity.PreviousHandle = id, to, from
	return out
}

// requestHandle is POST /api/me/handle {handle, request?}: an agent asks the owner for a new handle, or asks what became of its request.
func (s *Server) requestHandle(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.HandleRequest
	if !decode(w, r, &in) {
		return
	}
	now, me := s.Clock.Now(), c.lease.IdentityID
	if in.Request != "" {
		s.pollHandle(w, r, me, in.Request, now)
		return
	}
	// The same command run again after the owner approved: the handle is already the asked one, so say so instead of "taken".
	if who, found, err := identity.ByID(r.Context(), s.reader(), me); err != nil {
		s.internalError(w, r, err)
		return
	} else if found && who.Handle == handleOf(in.Handle) {
		if retired, err := identity.RetiredOf(r.Context(), s.reader(), me); err != nil {
			s.internalError(w, r, err)
		} else if len(retired) > 0 {
			writeJSON(w, http.StatusOK, handleChanged(me, retired[0].Handle, who.Handle))
		} else {
			writeFieldErr(w, http.StatusConflict, wire.CodeHandleTaken, "handle", "That is your handle already.")
		}
		return
	}
	var req identity.HandleRequest
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var filed bool
		var err error
		if req, filed, err = identity.FileHandleRequest(ctx, d, me, handleOf(in.Handle), now); err != nil || !filed {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: me, Machine: c.lease.MachineID, Session: c.lease.SessionID, Action: "identity.handle_requested",
			TargetKind: "identity", TargetID: me, Detail: map[string]any{"from": req.From, "to": req.To}}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, eventHandleRequested, map[string]any{"request_id": req.ID, "identity_id": me})
		return err
	})
	switch {
	case handleRefused(w, err):
	case err != nil:
		s.internalError(w, r, err)
	default:
		s.Bus.Notify()
		s.writeHandlePending(w, req)
	}
}

func (s *Server) writeHandlePending(w http.ResponseWriter, req identity.HandleRequest) {
	writeJSON(w, http.StatusAccepted, wire.HandlePending{Request: wire.HandleRequestState{
		Ref: req.Ref, State: identity.HandlePending, From: req.From, To: req.To, ExpiresAt: req.ExpiresAt, IntervalMs: s.interval().Milliseconds(),
	}})
}

// pollHandle answers an agent that asks about its request: 202 while it waits, 200 once approved.
func (s *Server) pollHandle(w http.ResponseWriter, r *http.Request, me int64, ref string, now time.Time) {
	req, err := identity.HandleRequestFor(r.Context(), s.reader(), me, ref, now)
	switch {
	case errors.Is(err, identity.ErrNoHandleRequest):
		writeErr(w, http.StatusNotFound, "not_found", "No such request.")
	case err != nil:
		s.internalError(w, r, err)
	case req.State == identity.HandlePending:
		s.writeHandlePending(w, req)
	case req.State == identity.HandleApproved:
		writeJSON(w, http.StatusOK, handleChanged(me, req.From, req.To))
	case req.State == identity.HandleDenied:
		writeErr(w, http.StatusForbidden, wire.CodeRequestDenied, "The owner denied the request.")
	default: // expired, or withdrawn by a newer request or by the owner's own change
		writeErr(w, http.StatusGone, wire.CodeRequestExpired, "The request is gone: it expired or was replaced. Ask again.")
	}
}

// changeHandle is POST /api/identities/:id/handle {handle}: the owner changes an agent's handle in Crew. No passkey check: the
// owner's signed-in session is the authority, as for Approve and Revoke key.
func (s *Server) changeHandle(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Handle string `json:"handle"`
	}
	if !decode(w, r, &in) {
		return
	}
	to := handleOf(in.Handle)
	var from string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d, now := tx.DBTX(), s.Clock.Now()
		who, found, err := identity.ByID(ctx, d, id)
		if err != nil {
			return err
		}
		if !found {
			return identity.ErrNotAgent
		}
		from = who.Handle
		return renameAgent(ctx, d, now, renamedBy{Human: c.human.ID, Device: c.dev.ID}, id, from, to)
	})
	switch {
	case handleRefused(w, err):
	case err != nil:
		s.internalError(w, r, err)
	default:
		s.Bus.Notify(id)
		writeJSON(w, http.StatusOK, handleChanged(id, from, to))
	}
}

// decideHandle is POST /api/handle-requests/:ref/{approve,deny}: the owner's one tap on the card "@old wants to be @new".
func decideHandle(approve bool) handler {
	return func(s *Server, w http.ResponseWriter, r *http.Request, c *call) {
		var in struct{}
		if !decode(w, r, &in) {
			return
		}
		var req identity.HandleRequest
		err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			d, now := tx.DBTX(), s.Clock.Now()
			var err error
			if req, err = identity.DecideHandleRequest(ctx, d, r.PathValue("ref"), c.human.ID, approve, now); err != nil || !approve {
				return err
			}
			return renameAgent(ctx, d, now, renamedBy{Human: c.human.ID, Device: c.dev.ID}, req.IdentityID, req.From, req.To)
		})
		switch {
		case errors.Is(err, identity.ErrNoHandleRequest):
			writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided, replaced or it expired.")
		case handleRefused(w, err):
		case err != nil:
			s.internalError(w, r, err)
		case !approve:
			s.Bus.Notify()
			writeJSON(w, http.StatusOK, map[string]any{})
		default:
			s.Bus.Notify(req.IdentityID)
			writeJSON(w, http.StatusOK, handleChanged(req.IdentityID, req.From, req.To))
		}
	}
}

// handleRequestJSON is a waiting handle request as Now shows it.
type handleRequestJSON struct {
	Ref         string `json:"ref"`
	IdentityID  int64  `json:"identity_id"`
	From        string `json:"from"`
	To          string `json:"to"`
	DisplayName string `json:"display_name"`
	CreatedAt   int64  `json:"created_at"`
	ExpiresAt   int64  `json:"expires_at"`
}

func handleRequestViews(ctx context.Context, d pdb.DBTX, now time.Time) ([]handleRequestJSON, error) {
	list, err := identity.PendingHandleRequests(ctx, d, now)
	out := make([]handleRequestJSON, 0, len(list))
	for _, h := range list {
		out = append(out, handleRequestJSON{Ref: h.Ref, IdentityID: h.IdentityID, From: h.From, To: h.To, DisplayName: h.DisplayName, CreatedAt: h.CreatedAt, ExpiresAt: h.ExpiresAt})
	}
	return out, err
}
