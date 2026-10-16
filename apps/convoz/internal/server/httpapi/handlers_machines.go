package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// allowJSON is an allow-list on the wire: handles and globs, not ids.
type allowJSON struct {
	Mode       string   `json:"mode"`
	Identities []string `json:"identities"`
	Globs      []string `json:"globs"`
}

func (a allowJSON) spec() auth.AllowSpec {
	return auth.AllowSpec{Mode: a.Mode, Identities: a.Identities, Globs: a.Globs}
}

func allowToJSON(a auth.Allow, handles map[int64]string) allowJSON {
	out := allowJSON{Mode: a.Mode, Identities: []string{}, Globs: []string{}}
	for _, id := range a.IdentityIDs {
		out.Identities = append(out.Identities, handles[id])
	}
	out.Globs = append(out.Globs, a.Globs...)
	return out
}

// machineJSON is one machine as the owner sees it. It never holds the key.
func machineJSON(m auth.Machine, handles map[int64]string) map[string]any {
	return map[string]any{
		"id": m.ID, "name": m.Name, "key_hint": m.KeyHint, "scopes": auth.ScopeNames(m.Scopes),
		"allow": allowToJSON(m.Allow, handles), "live_sessions": m.LiveSessions, "last_used_at": m.LastUsedAt,
	}
}

func (s *Server) machines(w http.ResponseWriter, r *http.Request, _ *call) {
	list, err := auth.ListMachines(r.Context(), s.reader(), s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	handles, err := identity.Handles(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, m := range list {
		out = append(out, machineJSON(m, handles))
	}
	writeJSON(w, http.StatusOK, map[string]any{"machines": out})
}

type approveBody struct {
	Name      string    `json:"name"`
	Allow     allowJSON `json:"allow"`
	Scopes    []string  `json:"scopes"`
	TypedCode string    `json:"typed_code"`
}

func (s *Server) approveRequest(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in approveBody
	if !decode(w, r, &in) {
		return
	}
	scopes := auth.DefaultScopes
	if in.Scopes != nil {
		if scopes, ok = auth.ScopeMask(in.Scopes); !ok {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "scopes", "The scopes must be a list of known scope names.")
			return
		}
	}
	now := s.Clock.Now()
	var machine auth.Machine
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		machine, err = auth.ApproveRequest(ctx, tx.DBTX(), s.Keys, flowPorts, auth.ApproveInput{
			RequestID: id, Name: in.Name, Allow: in.Allow.spec(), Scopes: scopes, TypedCode: in.TypedCode,
			Human: c.human, DeviceID: c.dev.ID, StepUpID: c.stepUp,
		}, now)
		return err
	})
	var bad auth.BadAllowError
	var taken *auth.NameTakenError
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoRequest):
		writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided or it expired.")
	case errors.Is(err, auth.ErrCodeMismatch):
		writeFieldErr(w, http.StatusBadRequest, "code_mismatch", "typed_code", "The code does not match")
	case errors.As(err, &taken):
		writeFieldErr(w, http.StatusConflict, "machine_name_taken", "name", fmt.Sprintf("The name %q is taken. Use Reveal or Regenerate on %q, or revoke it first.", taken.Name, taken.Name))
	case errors.Is(err, auth.ErrMachineCap):
		writeErr(w, http.StatusConflict, "machine_cap", "Ten machines are active. Revoke one before approving another.")
	case errors.Is(err, auth.ErrBadMachine):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "name", "A machine name has 1 to 60 characters from a-z, 0-9, . and -.")
	case errors.As(err, &bad):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "allow", bad.Error())
	case err != nil:
		s.internalError(w, r, err)
	default:
		handles, herr := identity.Handles(r.Context(), s.reader())
		if herr != nil {
			s.internalError(w, r, herr)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"machine": machineJSON(machine, handles)})
	}
}

func stepUpInvalid(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "step_up_invalid", "That passkey check is used up or expired. Check again.")
}

func (s *Server) denyRequest(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var denied bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		denied, err = auth.DenyMachineRequest(ctx, tx.DBTX(), journalPort{}, c.human, c.dev.ID, id, s.Clock.Now())
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !denied:
		writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided or it expired.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

func (s *Server) denyAllRequests(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var n int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		n, err = auth.DenyAllMachineRequests(ctx, tx.DBTX(), journalPort{}, c.human, c.dev.ID, s.Clock.Now())
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"denied": n})
}

func (s *Server) patchMachine(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Allow allowJSON `json:"allow"`
	}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	var machine auth.Machine
	var released []inbox.Released
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var ended []int64
		var err error
		machine, ended, err = auth.ReplaceMachineAllow(ctx, tx.DBTX(), flowPorts, auth.AllowChange{
			MachineID: id, Allow: in.Allow.spec(), Human: c.human, DeviceID: c.dev.ID, StepUpID: c.stepUp,
		}, now)
		if err != nil {
			return err
		}
		released, err = inbox.ReleaseSessions(ctx, tx.DBTX(), now, ended)
		return err
	})
	if err == nil {
		s.publishReleased(r.Context(), released)
	}
	var bad auth.BadAllowError
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoMachine):
		writeErr(w, http.StatusNotFound, "not_found", "No such machine.")
	case errors.As(err, &bad):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "allow", bad.Error())
	case err != nil:
		s.internalError(w, r, err)
	default:
		handles, herr := identity.Handles(r.Context(), s.reader())
		if herr != nil {
			s.internalError(w, r, herr)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"machine": machineJSON(machine, handles)})
	}
}

// machineAction reads the machine id and the empty body of a key action; false means the answer was written.
func machineAction(w http.ResponseWriter, r *http.Request, c *call) (auth.MachineAction, bool) {
	id, ok := pathID(w, r)
	if !ok {
		return auth.MachineAction{}, false
	}
	var in struct{}
	if !decode(w, r, &in) {
		return auth.MachineAction{}, false
	}
	return auth.MachineAction{CrewInput: auth.CrewInput{Human: c.human, DeviceID: c.dev.ID, StepUpID: c.stepUp}, MachineID: id}, true
}

func (s *Server) revealKey(w http.ResponseWriter, r *http.Request, c *call) {
	in, ok := machineAction(w, r, c)
	if !ok {
		return
	}
	var key string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		key, err = auth.RevealMachineKey(ctx, tx.DBTX(), s.Keys, journalPort{}, in, s.Clock.Now())
		return err
	})
	s.keyAnswer(w, r, err, func() map[string]any { return map[string]any{"machine_key": key} })
}

func (s *Server) regenerateKey(w http.ResponseWriter, r *http.Request, c *call) {
	in, ok := machineAction(w, r, c)
	if !ok {
		return
	}
	var key string
	var version int64
	var released []inbox.Released
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		now := s.Clock.Now()
		var ended []int64
		var err error
		key, version, ended, err = auth.RegenerateMachineKey(ctx, tx.DBTX(), s.Keys, journalPort{}, in, now)
		if err != nil {
			return err
		}
		released, err = inbox.ReleaseSessions(ctx, tx.DBTX(), now, ended)
		return err
	})
	if err == nil {
		s.publishReleased(r.Context(), released)
	}
	s.keyAnswer(w, r, err, func() map[string]any { return map[string]any{"machine_key": key, "key_version": version} })
}

// keyAnswer answers a reveal or a regenerate: the key goes out in this response and nowhere else.
func (s *Server) keyAnswer(w http.ResponseWriter, r *http.Request, err error, body func() map[string]any) {
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoMachine):
		writeErr(w, http.StatusNotFound, "not_found", "No such machine.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, body())
	}
}

func (s *Server) revokeMachine(w http.ResponseWriter, r *http.Request, c *call) {
	in, ok := machineAction(w, r, c)
	if !ok {
		return
	}
	var released []inbox.Released
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		now := s.Clock.Now()
		ended, err := auth.RevokeMachineByOwner(ctx, tx.DBTX(), journalPort{}, in, now)
		if err != nil {
			return err
		}
		released, err = inbox.ReleaseSessions(ctx, tx.DBTX(), now, ended)
		return err
	})
	if err == nil {
		s.publishReleased(r.Context(), released)
	}
	s.keyAnswer(w, r, err, func() map[string]any { return map[string]any{} })
}
