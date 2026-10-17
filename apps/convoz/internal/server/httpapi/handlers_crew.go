package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
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
	var made auth.Agent
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		made, err = auth.CreateAgent(ctx, tx.DBTX(), flowPorts, auth.NewCrewAgent{
			CrewInput: crewInput(c), Handle: in.Handle, DisplayName: in.DisplayName,
		}, now)
		return err
	})
	var invalid *auth.FieldError
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrHandleTaken):
		writeFieldErr(w, http.StatusConflict, "handle_taken", "handle", "That handle is taken or was used before.")
	case errors.As(err, &invalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.Field, invalid.Message)
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusCreated, map[string]any{"identity": map[string]any{"id": made.ID, "handle": made.Handle, "display_name": made.DisplayName, "kind": "agent"}})
	}
}

func crewInput(c *call) auth.CrewInput {
	return auth.CrewInput{Human: c.human, DeviceID: c.dev.ID, StepUpID: c.stepUp}
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
	var released []inbox.Released
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		now := s.Clock.Now()
		ended, err := auth.DisableAgent(ctx, tx.DBTX(), flowPorts, crewInput(c), id, now)
		if err != nil {
			return err
		}
		if released, err = releaseEnded(ctx, tx.DBTX(), now, ended); err != nil {
			return err
		}
		open, err := ask.CloseForDisable(ctx, tx.DBTX(), now, id)
		if err != nil {
			return err
		}
		for conv, n := range open {
			if err := conversation.AddOpenAsks(ctx, tx.DBTX(), conv, -n); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		s.publishReleased(r.Context(), released)
	}
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoAgent):
		writeErr(w, http.StatusNotFound, "not_found", "No such enabled agent.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}
