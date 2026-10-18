package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// reader is the read-only handle every module wraps with its own sqlc New.
func (s *Server) reader() pdb.DBTX { return s.Store.Reader.SQL() }

func humanOf(h identity.Human) auth.Human {
	return auth.Human{ID: h.ID, Handle: h.Handle, DisplayName: h.DisplayName, Role: h.Role}
}

// ownerJSON is the answer shape for "who".
type ownerJSON struct {
	ID          int64  `json:"id"`
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
}

func ownerOf(h auth.Human) ownerJSON { return ownerJSON{h.ID, h.Handle, h.DisplayName} }

func (s *Server) version(w http.ResponseWriter, _ *http.Request, _ *call) {
	out := map[string]any{"version": s.Cfg.Version}
	if s.Cfg.AgentOrigin != "" {
		out["agent_url"] = s.Cfg.AgentOrigin // the address an agent outside the tailnet connects to; the invite prompt shows it
	}
	writeJSON(w, http.StatusOK, out)
}

// ceremonyBody is the finish half of every WebAuthn ceremony.
type ceremonyBody struct {
	CeremonyID string          `json:"ceremony_id"`
	Credential json.RawMessage `json:"credential"`
}

func badCeremony(w http.ResponseWriter) {
	writeErr(w, http.StatusBadRequest, "ceremony_invalid", "This step expired. Start again.")
}

func badCredential(w http.ResponseWriter, status int) {
	writeErr(w, status, "invalid_credential", "That passkey did not work.")
}

// startCeremony stores c and answers {ceremony_id, options}.
func (s *Server) startCeremony(w http.ResponseWriter, c *auth.Ceremony, options any) {
	id := s.ceremonies.Put(c, s.Clock.Now())
	if id == "" {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_id": id, "options": options})
}

// ---- bootstrap -----------------------------------------------------------------------------------

func linkError(w http.ResponseWriter, state auth.LinkState) bool {
	switch state {
	case auth.LinkUnknown:
		writeErr(w, http.StatusNotFound, "bootstrap_invalid", "This link is not valid.")
	case auth.LinkUsed:
		writeErr(w, http.StatusGone, "bootstrap_used", "This link was already used. Make a new one on the server.")
	case auth.LinkExpired:
		writeErr(w, http.StatusGone, "bootstrap_expired", "This link expired. Make a new one on the server.")
	default:
		return false
	}
	return true
}

// bootstrapCheck tells the setup page, when it opens, what its link is worth; the page then shows the form or says
// what happened. It changes nothing.
func (s *Server) bootstrapCheck(w http.ResponseWriter, r *http.Request, _ *call) {
	var in struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &in) {
		return
	}
	_, state, err := auth.CheckBootstrapLink(r.Context(), s.reader(), in.Token, s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	states := map[auth.LinkState]string{auth.LinkOK: "ok", auth.LinkUnknown: "invalid", auth.LinkUsed: "used", auth.LinkExpired: "expired"}
	writeJSON(w, http.StatusOK, map[string]any{"state": states[state]})
}

func (s *Server) bootstrapOptions(w http.ResponseWriter, r *http.Request, _ *call) {
	var in struct {
		Token       string `json:"token"`
		Handle      string `json:"handle"`
		DisplayName string `json:"display_name"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	_, state, err := auth.CheckBootstrapLink(ctx, s.reader(), in.Token, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if linkError(w, state) {
		return
	}
	// Once an owner exists the link only adds a passkey to that owner; the typed name is ignored (I-1).
	var existing []auth.Passkey
	human := auth.Human{Handle: in.Handle, DisplayName: in.DisplayName, Role: "owner"}
	owner, err := identity.Owner(ctx, s.reader())
	switch {
	case err == nil:
		human = humanOf(owner)
		if existing, err = auth.ListPasskeys(ctx, s.reader(), owner.ID); err != nil {
			s.internalError(w, r, err)
			return
		}
	case errors.Is(err, identity.ErrNotFound):
		if !identity.ValidHandle(in.Handle) || !identity.ValidDisplayName(in.DisplayName) {
			writeErr(w, http.StatusBadRequest, "invalid_request", "Pick a handle (2 to 40 of a-z, 0-9 and -, starting with a letter) and a display name.")
			return
		}
	default:
		s.internalError(w, r, err)
		return
	}
	creation, sd, err := auth.BeginRegistration(s.WA, human, existing)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.startCeremony(w, &auth.Ceremony{Kind: "bootstrap", Session: *sd, Token: in.Token, Handle: in.Handle, Display: in.DisplayName}, creation)
}

func (s *Server) bootstrapVerify(w http.ResponseWriter, r *http.Request, _ *call) {
	var in ceremonyBody
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	cer, ok := s.ceremonies.Take(in.CeremonyID, "bootstrap", now)
	if !ok {
		badCeremony(w)
		return
	}
	human := auth.Human{Handle: cer.Handle, DisplayName: cer.Display, Role: "owner"}
	var existing []auth.Passkey
	if owner, err := identity.Owner(ctx, s.reader()); err == nil {
		human = humanOf(owner)
		existing, err = auth.ListPasskeys(ctx, s.reader(), owner.ID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	cred, err := auth.FinishRegistration(s.WA, human, existing, cer.Session, in.Credential)
	if err != nil {
		badCredential(w, http.StatusBadRequest)
		return
	}

	var res auth.BootstrapResult
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		res, err = auth.Bootstrap(ctx, tx.DBTX(), bootstrapPorts, auth.BootstrapInput{
			Token: cer.Token, Handle: cer.Handle, DisplayName: cer.Display, UserAgent: r.UserAgent(), Credential: cred,
		}, now)
		return err
	})
	switch {
	case errors.Is(err, auth.ErrLinkUsed):
		linkError(w, auth.LinkUsed)
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	case linkError(w, res.State):
		return
	}
	setDeviceCookie(w, res.DeviceToken, int(auth.DeviceIdle/time.Second))
	out := map[string]any{"owner": ownerOf(res.Owner)}
	if res.Created {
		out["recovery_codes"] = res.RecoveryCodes
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- sign in -------------------------------------------------------------------------------------

func (s *Server) loginOptions(w http.ResponseWriter, r *http.Request, _ *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	assertion, sd, err := auth.BeginDiscoverableLogin(s.WA)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.startCeremony(w, &auth.Ceremony{Kind: "login", Session: *sd}, assertion)
}

func (s *Server) loginVerify(w http.ResponseWriter, r *http.Request, _ *call) {
	var in ceremonyBody
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	cer, ok := s.ceremonies.Take(in.CeremonyID, "login", now)
	if !ok {
		badCeremony(w)
		return
	}
	lookup := func(ctx context.Context, userHandle []byte) (auth.Human, []auth.Passkey, error) {
		h, err := identity.ByHandle(ctx, s.reader(), string(userHandle))
		if err != nil {
			return auth.Human{}, nil, err
		}
		keys, err := auth.ListPasskeys(ctx, s.reader(), h.ID)
		return humanOf(h), keys, err
	}
	human, cred, err := auth.FinishDiscoverableLogin(ctx, s.WA, cer.Session, in.Credential, lookup)
	if err != nil {
		badCredential(w, http.StatusUnauthorized)
		return
	}
	var token string
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		pk, found, err := auth.PasskeyByCredential(ctx, d, cred.ID)
		if err != nil {
			return err
		}
		if !found {
			return errNoPasskey
		}
		if err := auth.UsePasskey(ctx, d, pk.ID, cred.Authenticator.SignCount, now); err != nil {
			return err
		}
		var deviceID int64
		if token, deviceID, err = auth.StartDevice(ctx, d, human.ID, pk.ID, r.UserAgent(), false, now); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: human.ID, Device: deviceID, Action: "device.login", TargetKind: "passkey", TargetID: pk.ID})
	})
	if errors.Is(err, errNoPasskey) {
		badCredential(w, http.StatusUnauthorized)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	setDeviceCookie(w, token, int(auth.DeviceIdle/time.Second))
	writeJSON(w, http.StatusOK, map[string]any{"owner": ownerOf(human)})
}

var errNoPasskey = errors.New("passkey is not active")

// ---- recovery ------------------------------------------------------------------------------------

// invalidCode is the one answer for a wrong, used, revoked or rate-limited code: the same bytes every time.
func invalidCode(w http.ResponseWriter) {
	writeErr(w, http.StatusUnauthorized, "invalid_code", "That code is not valid.")
}

func (s *Server) recovery(w http.ResponseWriter, r *http.Request, _ *call) {
	var in struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	// 10 attempts an hour for everyone, right or wrong: a guesser gains nothing from many addresses.
	if !s.recoveryLimit.Allow("recovery", now) {
		invalidCode(w)
		return
	}
	var token string
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		humanID, ok, err := auth.UseRecoveryCode(ctx, d, in.Code, now)
		if err != nil {
			return err
		}
		if !ok {
			return errBadCode
		}
		var deviceID int64
		if token, deviceID, err = auth.StartDevice(ctx, d, humanID, 0, r.UserAgent(), true, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, d, now, audit.Entry{Actor: humanID, Device: deviceID, Action: "recovery.used"}); err != nil {
			return err
		}
		_, err = event.Append(ctx, d, now, "recovery.used.v1", map[string]any{"identity_id": humanID})
		return err
	})
	if errors.Is(err, errBadCode) {
		invalidCode(w)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	setDeviceCookie(w, token, int(auth.RecoveryDeviceTTL/time.Second))
	writeJSON(w, http.StatusOK, map[string]any{"limited": true})
}

var errBadCode = errors.New("recovery code not valid")

// ---- add a passkey -------------------------------------------------------------------------------

func (s *Server) registerOptions(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	existing, err := auth.ListPasskeys(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	creation, sd, err := auth.BeginRegistration(s.WA, c.human, existing)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.startCeremony(w, &auth.Ceremony{Kind: "register", Session: *sd, HumanID: c.human.ID, DeviceID: c.dev.ID}, creation)
}

func (s *Server) registerVerify(w http.ResponseWriter, r *http.Request, c *call) {
	var in ceremonyBody
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	cer, ok := s.ceremonies.Take(in.CeremonyID, "register", now)
	if !ok || cer.DeviceID != c.dev.ID {
		badCeremony(w)
		return
	}
	existing, err := auth.ListPasskeys(ctx, s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	cred, err := auth.FinishRegistration(s.WA, c.human, existing, cer.Session, in.Credential)
	if err != nil {
		badCredential(w, http.StatusBadRequest)
		return
	}
	var res auth.RegisterResult
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		res, err = registerPasskey(ctx, tx.DBTX(), c, r.UserAgent(), cred, now)
		return err
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		writeErr(w, http.StatusForbidden, "step_up_invalid", "That passkey check is used up or expired. Check again.")
	case errors.Is(err, auth.ErrDeviceGone):
		writeErr(w, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		if res.DeviceToken != "" { // recovery: the recovery device ended, a full session for the new passkey replaces it
			setDeviceCookie(w, res.DeviceToken, int(auth.DeviceIdle/time.Second))
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// ---- step-up -------------------------------------------------------------------------------------

func (s *Server) stepUpOptions(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		Action   string `json:"action"`
		TargetID *int64 `json:"target_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !auth.StepUpActions[in.Action] {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Unknown action.")
		return
	}
	passkeys, err := auth.ListPasskeys(r.Context(), s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	assertion, sd, err := auth.BeginStepUp(s.WA, c.human, passkeys)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.startCeremony(w, &auth.Ceremony{Kind: "stepup", Session: *sd, HumanID: c.human.ID, DeviceID: c.dev.ID, Action: in.Action, TargetID: in.TargetID}, assertion)
}

func (s *Server) stepUpVerify(w http.ResponseWriter, r *http.Request, c *call) {
	var in ceremonyBody
	if !decode(w, r, &in) {
		return
	}
	ctx, now := r.Context(), s.Clock.Now()
	cer, ok := s.ceremonies.Take(in.CeremonyID, "stepup", now)
	if !ok || cer.DeviceID != c.dev.ID {
		badCeremony(w)
		return
	}
	passkeys, err := auth.ListPasskeys(ctx, s.reader(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	cred, err := auth.FinishStepUp(s.WA, c.human, passkeys, cer.Session, in.Credential)
	if err != nil {
		badCredential(w, http.StatusUnauthorized)
		return
	}
	pk, found := auth.FindPasskey(passkeys, cred.ID)
	if !found {
		badCredential(w, http.StatusUnauthorized)
		return
	}
	if err := auth.CheckDestructive(pk, cer.Action, now); err != nil {
		writeErr(w, http.StatusForbidden, "passkey_too_new", "This passkey is too new. Actions like this unlock at "+time.UnixMilli(pk.DestructiveAt).UTC().Format("2006-01-02 15:04 MST")+".")
		return
	}
	var id int64
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.UsePasskey(ctx, d, pk.ID, cred.Authenticator.SignCount, now); err != nil {
			return err
		}
		var err error
		id, err = auth.IssueStepUp(ctx, d, c.dev.ID, pk.ID, cer.Action, cer.TargetID, now)
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"step_up_id": id})
}

// ---- logout --------------------------------------------------------------------------------------

func (s *Server) logout(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, err := auth.RevokeDevice(ctx, d, c.human.ID, c.dev.ID, "logout", now); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "device.logout"})
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.streams.cancelDevice(c.dev.ID) // its event streams end now, not at the next heartbeat
	clearDeviceCookie(w)
	w.Header().Set("Clear-Site-Data", `"cache","cookies","storage"`)
	w.WriteHeader(http.StatusNoContent)
}
