package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func (s *Server) createAgent(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		Handle      string `json:"handle"`
		DisplayName string `json:"display_name"`
	}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	var made identity.Principal
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "identity.create", nil, now); err != nil {
			return err
		}
		var err error
		if made, err = identity.CreateAgent(ctx, d, identity.NewAgent{Handle: in.Handle, DisplayName: in.DisplayName, ByHuman: c.human.ID}, now); err != nil {
			return agentError(err)
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "identity.created", TargetKind: "identity", TargetID: made.ID}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "identity.created", map[string]any{"identity_id": made.ID})
		return err
	})
	var invalid errFieldInvalid
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, errHandleTaken):
		writeFieldErr(w, http.StatusConflict, "handle_taken", "handle", "That handle is taken or was used before.")
	case errors.As(err, &invalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.field, invalid.message)
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusCreated, map[string]any{"identity": map[string]any{"id": made.ID, "handle": made.Handle, "display_name": made.DisplayName, "kind": "agent"}})
	}
}

func (s *Server) disableIdentity(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "identity.disable", &id, now); err != nil {
			return err
		}
		disabled, err := identity.DisableAgent(ctx, d, id, now)
		if err != nil {
			return err
		}
		if !disabled {
			return identity.ErrNotAgent
		}
		// Every lease of the identity ends in the same transaction, on every machine.
		if err := auth.EndIdentitySessions(ctx, d, id, "identity_disabled", now); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "identity.disabled", TargetKind: "identity", TargetID: id}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "identity.disabled", map[string]any{"identity_id": id})
		return err
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, identity.ErrNotAgent):
		writeErr(w, http.StatusNotFound, "not_found", "No such enabled agent.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}
