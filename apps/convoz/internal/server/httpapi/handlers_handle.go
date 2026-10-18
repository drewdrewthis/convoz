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

// An agent's handle can change (I-51): the agent changes its own at once, or the owner changes it in Crew.
// Owner (2026-10-18): "Handles I think can also change, that seems fine because there's an id, right?" And, asked whether an
// agent's own change needs approval: "Change at once, no approval" ("too defensive and requires too much machinery").

// Event name of a handle change. Thin: ids only (I-23).
const eventHandleChanged = "identity.handle_changed.v1"

// renamedBy is who makes a change: the owner with the device the tap came from, or the agent with its machine and session.
type renamedBy struct{ Actor, Device, Machine, Session int64 }

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
		if _, _, err := sayLine(ctx, d, now, by.Actor, cv.ID, message.SystemLine{T: "member.renamed", Identity: agentID, From: from, To: to}); err != nil {
			return err
		}
	}
	if err := audit.Write(ctx, d, now, audit.Entry{Actor: by.Actor, Device: by.Device, Machine: by.Machine, Session: by.Session, Action: "identity.handle_changed", TargetKind: "identity", TargetID: agentID,
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
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "A handle changes 3 times a day at most.")
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

// handleChanged is the answer of a change: the old handle keeps reaching the agent until previous_until.
func handleChanged(id int64, from, to string, now time.Time) wire.HandleChanged {
	var out wire.HandleChanged
	out.Identity.ID, out.Identity.Handle, out.Identity.PreviousHandle = id, to, from
	out.Identity.PreviousUntil = now.Add(identity.HandleGrace).UnixMilli()
	return out
}

// changeOwnHandle is POST /api/me/handle {handle}: an agent changes its own handle at once, no approval. The same path as the
// owner's change, so the old handle stays an alias, every conversation the agent is in says so, and nothing pushes.
func (s *Server) changeOwnHandle(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.HandleChange
	if !decode(w, r, &in) {
		return
	}
	me, to := c.lease.IdentityID, handleOf(in.Handle)
	var from string
	var now time.Time
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		now = s.Clock.Now()
		who, found, err := identity.ByID(ctx, d, me)
		if err != nil {
			return err
		}
		if !found {
			return identity.ErrNotAgent
		}
		from = who.Handle
		return renameAgent(ctx, d, now, renamedBy{Actor: me, Machine: c.lease.MachineID, Session: c.lease.SessionID}, me, from, to)
	})
	switch {
	case handleRefused(w, err):
	case err != nil:
		s.internalError(w, r, err)
	default:
		s.Bus.Notify(me)
		writeJSON(w, http.StatusOK, handleChanged(me, from, to, now))
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
	var now time.Time
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		now = s.Clock.Now()
		who, found, err := identity.ByID(ctx, d, id)
		if err != nil {
			return err
		}
		if !found {
			return identity.ErrNotAgent
		}
		from = who.Handle
		return renameAgent(ctx, d, now, renamedBy{Actor: c.human.ID, Device: c.dev.ID}, id, from, to)
	})
	switch {
	case handleRefused(w, err):
	case err != nil:
		s.internalError(w, r, err)
	default:
		s.Bus.Notify(id)
		writeJSON(w, http.StatusOK, handleChanged(id, from, to, now))
	}
}
