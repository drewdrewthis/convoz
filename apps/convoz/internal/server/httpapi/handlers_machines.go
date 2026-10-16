package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// maxAllowEntries bounds an allow-list so a request cannot make a huge one.
const maxAllowEntries = 100

// allowJSON is an allow-list on the wire: handles and globs, not ids.
type allowJSON struct {
	Mode       string   `json:"mode"`
	Identities []string `json:"identities"`
	Globs      []string `json:"globs"`
}

func allowToJSON(a auth.Allow, handles map[int64]string) allowJSON {
	out := allowJSON{Mode: a.Mode, Identities: []string{}, Globs: []string{}}
	for _, id := range a.IdentityIDs {
		out.Identities = append(out.Identities, handles[id])
	}
	out.Globs = append(out.Globs, a.Globs...)
	return out
}

// errBadAllow carries the sentence for a refused allow-list.
type errBadAllow string

func (e errBadAllow) Error() string { return string(e) }

// allowFromJSON turns handles into agent ids. A handle that is not an agent, and a glob that cannot be stored, are refused.
func allowFromJSON(ctx context.Context, d pdb.DBTX, in allowJSON) (auth.Allow, error) {
	switch in.Mode {
	case auth.AllowAny:
		return auth.Allow{Mode: auth.AllowAny}, nil
	case auth.AllowList:
	default:
		return auth.Allow{}, errBadAllow(`The allow-list mode must be "list" or "any".`)
	}
	if len(in.Identities)+len(in.Globs) > maxAllowEntries {
		return auth.Allow{}, errBadAllow("The allow-list is too long.")
	}
	out := auth.Allow{Mode: auth.AllowList}
	for _, h := range in.Identities {
		p, found, err := identity.Lookup(ctx, d, h)
		if err != nil {
			return auth.Allow{}, err
		}
		if !found || p.Kind != "agent" {
			return auth.Allow{}, errBadAllow(fmt.Sprintf("There is no agent %q.", h))
		}
		if !slices.Contains(out.IdentityIDs, p.ID) {
			out.IdentityIDs = append(out.IdentityIDs, p.ID)
		}
	}
	for _, g := range in.Globs {
		if !auth.ValidGlob(g) {
			return auth.Allow{}, errBadAllow(fmt.Sprintf("The pattern %q can only hold a-z, 0-9, -, * and ?.", g))
		}
		if !slices.Contains(out.Globs, g) {
			out.Globs = append(out.Globs, g)
		}
	}
	return out, nil
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

// machineByID finds one active machine in a list read inside the open transaction.
func machineByID(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (auth.Machine, error) {
	list, err := auth.ListMachines(ctx, d, now)
	if err != nil {
		return auth.Machine{}, err
	}
	for _, m := range list {
		if m.ID == id {
			return m, nil
		}
	}
	return auth.Machine{}, auth.ErrNoMachine
}

var errCodeMismatch = errors.New("the typed code does not match")

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
	var name string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "machine.approve", &id, now); err != nil {
			return err
		}
		req, err := auth.PendingRequest(ctx, d, id, now)
		if err != nil {
			return err
		}
		waiting, err := auth.CountPendingRequests(ctx, d, now)
		if err != nil {
			return err
		}
		if waiting > 1 && in.TypedCode != req.UserCode {
			return errCodeMismatch
		}
		if name = in.Name; name == "" {
			name = req.Name
		}
		// The name and the cap come before the allow-list: a refusal for either needs no handle to exist.
		if err := auth.CheckMachineSlot(ctx, d, name); err != nil {
			return err
		}
		allow, err := allowFromJSON(ctx, d, in.Allow)
		if err != nil {
			return err
		}
		machineID, err := auth.CreateMachine(ctx, d, s.Keys, auth.NewMachine{Name: name, Scopes: scopes, Allow: allow, ApprovedBy: c.human.ID}, now)
		if err != nil {
			return err
		}
		if err := auth.MarkApproved(ctx, d, id, machineID, c.human.ID, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Machine: machineID, Action: "machine.approved", TargetKind: "machine", TargetID: machineID, Detail: map[string]any{"request_id": id}}); err != nil {
			return err
		}
		if _, err := event.Append(ctx, d, now, "machine.approved", map[string]any{"machine_id": machineID, "request_id": id}); err != nil {
			return err
		}
		machine, err = machineByID(ctx, d, machineID, now)
		return err
	})
	var bad errBadAllow
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoRequest):
		writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided or it expired.")
	case errors.Is(err, errCodeMismatch):
		writeFieldErr(w, http.StatusBadRequest, "code_mismatch", "typed_code", "The code does not match")
	case errors.Is(err, auth.ErrNameTaken):
		writeFieldErr(w, http.StatusConflict, "machine_name_taken", "name", fmt.Sprintf("The name %q is taken. Use Reveal or Regenerate on %q, or revoke it first.", name, name))
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
	now := s.Clock.Now()
	var denied bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var err error
		if denied, err = auth.DenyRequest(ctx, d, id, c.human.ID, now); err != nil || !denied {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "machine.denied", TargetKind: "machine_request", TargetID: id})
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
	now := s.Clock.Now()
	var n int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var err error
		if n, err = auth.DenyAllRequests(ctx, d, c.human.ID, now); err != nil || n == 0 {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "machine.denied", TargetKind: "machine_request", Detail: map[string]any{"count": n}})
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
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "machine.allow", &id, now); err != nil {
			return err
		}
		if _, err := machineByID(ctx, d, id, now); err != nil {
			return err
		}
		allow, err := allowFromJSON(ctx, d, in.Allow)
		if err != nil {
			return err
		}
		if err := s.endUncovered(ctx, d, id, allow, now); err != nil {
			return err
		}
		if err := auth.ReplaceAllow(ctx, d, id, allow); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Machine: id, Action: "machine.allow_changed", TargetKind: "machine", TargetID: id}); err != nil {
			return err
		}
		if _, err := event.Append(ctx, d, now, "machine.allow_changed", map[string]any{"machine_id": id}); err != nil {
			return err
		}
		machine, err = machineByID(ctx, d, id, now)
		return err
	})
	var bad errBadAllow
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

// endUncovered ends the leases on the machine of every identity that the new allow-list does not cover. Only
// this machine's leases end; the same identity keeps working on other machines.
func (s *Server) endUncovered(ctx context.Context, d pdb.DBTX, machineID int64, next auth.Allow, now time.Time) error {
	live, err := auth.LiveSessionIdentities(ctx, d, machineID, now)
	if err != nil || len(live) == 0 {
		return err
	}
	handles, err := identity.Handles(ctx, d)
	if err != nil {
		return err
	}
	for _, identityID := range live {
		if next.Covers(identityID, handles[identityID]) {
			continue
		}
		if err := auth.EndMachineIdentitySessions(ctx, d, machineID, identityID, "allow_removed", now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) revealKey(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	var key string
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "machine.reveal", &id, now); err != nil {
			return err
		}
		var err error
		if key, err = auth.RevealKey(ctx, d, s.Keys, id); err != nil {
			return err
		}
		// The audit line and the event name the machine and never the key.
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Machine: id, Action: "machine.key_revealed", TargetKind: "machine", TargetID: id}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "machine.key_revealed", map[string]any{"machine_id": id})
		return err
	})
	s.keyAnswer(w, r, err, func() map[string]any { return map[string]any{"machine_key": key} })
}

func (s *Server) regenerateKey(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	var key string
	var version int64
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "machine.regenerate", &id, now); err != nil {
			return err
		}
		var err error
		if key, version, err = auth.RegenerateKey(ctx, d, s.Keys, id, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Machine: id, Action: "machine.key_regenerated", TargetKind: "machine", TargetID: id, Detail: map[string]any{"key_version": version}}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "machine.key_regenerated", map[string]any{"machine_id": id, "key_version": version})
		return err
	})
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
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "machine.revoke", &id, now); err != nil {
			return err
		}
		revoked, err := auth.RevokeMachine(ctx, d, id, now)
		if err != nil {
			return err
		}
		if !revoked {
			return auth.ErrNoMachine
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Machine: id, Action: "machine.revoked", TargetKind: "machine", TargetID: id}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "machine.revoked", map[string]any{"machine_id": id})
		return err
	})
	s.keyAnswer(w, r, err, func() map[string]any { return map[string]any{} })
}
