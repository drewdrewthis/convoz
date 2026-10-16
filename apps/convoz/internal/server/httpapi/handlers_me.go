package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func (s *Server) me(w http.ResponseWriter, r *http.Request, c *call) {
	if c.p.SessionID != 0 {
		s.leaseMe(w, r, c)
		return
	}
	out := map[string]any{
		"identity": map[string]any{"id": c.human.ID, "handle": c.human.Handle, "display_name": c.human.DisplayName, "role": c.human.Role, "kind": "human"},
		"device":   map[string]any{"id": c.dev.ID, "limited": c.dev.Limited},
	}
	note, err := auth.RecoveryNote(r.Context(), s.reader(), c.human.ID, c.dev.PasskeyID, s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if note != nil {
		out["recovery"] = note
	}
	writeJSON(w, http.StatusOK, out)
}

// identityJSON is an identity in the list. An agent says who made it: the owner, or a machine by name.
type identityJSON struct {
	identity.Entry
	CreatedBy *createdByJSON `json:"created_by,omitempty"`
	// Online is set on agents: true while the agent has a live session on any machine.
	Online *bool `json:"online,omitempty"`
}

type createdByJSON struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

func (s *Server) identities(w http.ResponseWriter, r *http.Request, _ *call) {
	list, err := identity.List(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	machines, err := auth.MachineNames(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	names := make(map[int64]string, len(list))
	for _, e := range list {
		names[e.ID] = e.DisplayName
	}
	out := make([]identityJSON, 0, len(list))
	for _, e := range list {
		row := identityJSON{Entry: e}
		if e.Kind == "agent" {
			live, err := auth.LiveSessionCount(r.Context(), s.reader(), e.ID, s.Clock.Now())
			if err != nil {
				s.internalError(w, r, err)
				return
			}
			online := live > 0
			row.Online = &online
		}
		switch {
		case e.CreatedByHuman != 0:
			row.CreatedBy = &createdByJSON{"human", names[e.CreatedByHuman]}
		case e.CreatedByMachine != 0:
			row.CreatedBy = &createdByJSON{"machine", machines[e.CreatedByMachine]}
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"identities": out})
}

type deviceJSON struct {
	auth.DeviceInfo
	Current bool `json:"current"`
}

func (s *Server) devices(w http.ResponseWriter, r *http.Request, c *call) {
	list, err := auth.ListDevices(r.Context(), s.reader(), c.human.ID, s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]deviceJSON, 0, len(list))
	for _, d := range list {
		out = append(out, deviceJSON{d, d.ID == c.dev.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

// pathID reads the ":id" segment; it writes the 404 itself and reports false for a non-number.
func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusNotFound, "not_found", "No such item.")
		return 0, false
	}
	return id, true
}

func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var revoked bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var err error
		if revoked, err = auth.RevokeDevice(ctx, d, c.human.ID, id, "user", now); err != nil || !revoked {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "device.revoked", TargetKind: "device", TargetID: id})
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !revoked:
		writeErr(w, http.StatusNotFound, "not_found", "No such device.")
	default:
		s.streams.cancelDevice(id)
		if id == c.dev.ID {
			clearDeviceCookie(w)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type passkeyJSON struct {
	ID            int64  `json:"id"`
	Label         string `json:"label"`
	RegisteredVia string `json:"registered_via"`
	CreatedAt     int64  `json:"created_at"`
	LastUsedAt    *int64 `json:"last_used_at"`
	ThisDevice    bool   `json:"this_device"` // the passkey the calling device signed in with
}

func (s *Server) passkeys(w http.ResponseWriter, r *http.Request, c *call) {
	keys, err := auth.ListPasskeys(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]passkeyJSON, 0, len(keys))
	for _, k := range keys {
		out = append(out, passkeyJSON{k.ID, k.Label, k.RegisteredVia, k.CreatedAt, k.LastUsedAt, k.ID == c.dev.PasskeyID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"passkeys": out})
}

func (s *Server) deletePasskey(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var signedOut []int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		// The step-up is spent first; an error below rolls it back, so a refused removal costs no new check.
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "passkey.remove", &id, now); err != nil {
			return err
		}
		var err error
		if signedOut, err = auth.RemovePasskey(ctx, d, c.human.ID, id, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "passkey.removed", TargetKind: "passkey", TargetID: id}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "passkey.removed.v1", map[string]any{"identity_id": c.human.ID, "passkey_id": id})
		return err
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		writeErr(w, http.StatusForbidden, "step_up_invalid", "That passkey check is used up or expired. Check again.")
	case errors.Is(err, auth.ErrLastPasskey):
		writeErr(w, http.StatusConflict, "last_passkey", "Another passkey must be added first.")
	case errors.Is(err, auth.ErrNoPasskey):
		writeErr(w, http.StatusNotFound, "not_found", "No such passkey.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		for _, dev := range signedOut { // their event streams end now, not at the next heartbeat
			s.streams.cancelDevice(dev)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// recoveryCount is GET /api/me/recovery-codes: how many codes can still be used.
func (s *Server) recoveryCount(w http.ResponseWriter, r *http.Request, c *call) {
	n, err := auth.RecoveryCodesLeft(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"remaining": n})
}

func (s *Server) regenerateRecoveryCodes(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var codes []string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		codes, err = auth.RegenerateRecoveryCodes(ctx, tx.DBTX(), journalPort{}, auth.CrewInput{Human: c.human, DeviceID: c.dev.ID, StepUpID: c.stepUp}, s.Clock.Now())
		return err
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": codes})
	}
}

func (s *Server) auditList(w http.ResponseWriter, r *http.Request, _ *call) {
	rows, err := audit.List(r.Context(), s.reader(), 100)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit": rows})
}
