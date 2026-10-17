package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
)

// getSettings is GET /api/settings: every registry key at its stored value or its default.
func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, c *call) {
	all, err := settings.All(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": all})
}

// patchSettings is PATCH /api/settings {scope, key, value}. The registry decides what is allowed (I-29); a workspace key is the owner's.
func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		Scope settings.Scope  `json:"scope"`
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Scope == settings.Workspace && c.p.Role != "owner" {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the owner changes workspace settings.")
		return
	}
	var out settings.Entry
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		out, err = settings.Set(ctx, tx.DBTX(), s.Clock.Now(), c.human.ID, in.Scope, in.Key, in.Value)
		return err
	})
	switch {
	case errors.Is(err, settings.ErrInvalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "value", err.Error())
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, out)
	}
}

// themeBootAsset serves (under /assets/settings/, a path of the module, so the console package keeps serving only its build files) the boot script that paints the look before the first frame. no-cache with an ETag: a new binary's
// script reaches the browser on its next load, and an unchanged one costs a 304.
func themeBootAsset(_ *Server, w http.ResponseWriter, r *http.Request, _ *call) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", themeBoot())
	http.ServeContent(w, r, "", time.Time{}, themeBootReader())
}
