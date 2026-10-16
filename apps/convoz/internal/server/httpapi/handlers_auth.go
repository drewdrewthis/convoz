package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	auditdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	authdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	eventdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/event/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	identitydb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// modules is one transaction's view of every module the auth handlers touch.
type modules struct {
	auth     *authdb.Queries
	identity *identitydb.Queries
	audit    *auditdb.Queries
	event    *eventdb.Queries
}

func inTx(tx *pdb.Tx) modules {
	d := tx.DBTX()
	return modules{authdb.New(d), identitydb.New(d), auditdb.New(d), eventdb.New(d)}
}

func authQueries(s *pdb.Store) *authdb.Queries         { return authdb.New(s.Reader.SQL()) }
func identityQueries(s *pdb.Store) *identitydb.Queries { return identitydb.New(s.Reader.SQL()) }

func (s *Server) readAuth() *authdb.Queries         { return authQueries(s.Store) }
func (s *Server) readIdentity() *identitydb.Queries { return identityQueries(s.Store) }

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

func passkeyLabel(now time.Time) string { return "Passkey " + now.UTC().Format("2006-01-02") }

func (s *Server) version(w http.ResponseWriter, _ *http.Request, _ *call) {
	writeJSON(w, http.StatusOK, map[string]any{"version": s.Cfg.Version})
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
	_, state, err := auth.CheckBootstrapLink(ctx, s.readAuth(), in.Token, now)
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
	owner, err := identity.Owner(ctx, s.readIdentity())
	switch {
	case err == nil:
		human = humanOf(owner)
		if existing, err = auth.ListPasskeys(ctx, s.readAuth(), owner.ID); err != nil {
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
	if owner, err := identity.Owner(ctx, s.readIdentity()); err == nil {
		human = humanOf(owner)
		existing, err = auth.ListPasskeys(ctx, s.readAuth(), owner.ID)
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

	var (
		owner   identity.Human
		codes   []string
		token   string
		state   = auth.LinkOK
		created bool
	)
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		m := inTx(tx)
		linkID, st, err := auth.CheckBootstrapLink(ctx, m.auth, cer.Token, now)
		if err != nil || st != auth.LinkOK {
			state = st
			return err
		}
		owner, err = identity.Owner(ctx, m.identity)
		if errors.Is(err, identity.ErrNotFound) {
			created = true
			owner, err = identity.CreateOwner(ctx, m.identity, cer.Handle, cer.Display, now)
		}
		if err != nil {
			return err
		}
		passkeyID, err := auth.AddPasskey(ctx, m.auth, owner.ID, cred, passkeyLabel(now), "bootstrap", now)
		if err != nil {
			return err
		}
		if err := auth.UseBootstrapLink(ctx, m.auth, linkID, passkeyID, now); err != nil {
			return err
		}
		if created {
			if codes, err = auth.NewRecoveryCodes(ctx, m.auth, owner.ID, now); err != nil {
				return err
			}
		}
		var deviceID int64
		if token, deviceID, err = auth.StartDevice(ctx, m.auth, owner.ID, passkeyID, r.UserAgent(), false, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, m.audit, now, audit.Entry{Actor: owner.ID, Device: deviceID, Action: "bootstrap.used", TargetKind: "passkey", TargetID: passkeyID}); err != nil {
			return err
		}
		if created {
			if _, err := event.Append(ctx, m.event, now, "owner.created", map[string]any{"identity_id": owner.ID}); err != nil {
				return err
			}
		}
		_, err = event.Append(ctx, m.event, now, "passkey.added", map[string]any{"identity_id": owner.ID, "passkey_id": passkeyID, "via": "bootstrap"})
		return err
	})
	switch {
	case errors.Is(err, auth.ErrLinkUsed):
		linkError(w, auth.LinkUsed)
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	case linkError(w, state):
		return
	}
	setDeviceCookie(w, token, int(auth.DeviceIdle/time.Second))
	out := map[string]any{"owner": ownerOf(humanOf(owner))}
	if created {
		out["recovery_codes"] = codes
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
		h, err := identity.ByHandle(ctx, s.readIdentity(), string(userHandle))
		if err != nil {
			return auth.Human{}, nil, err
		}
		keys, err := auth.ListPasskeys(ctx, s.readAuth(), h.ID)
		return humanOf(h), keys, err
	}
	human, cred, err := auth.FinishDiscoverableLogin(ctx, s.WA, cer.Session, in.Credential, lookup)
	if err != nil {
		badCredential(w, http.StatusUnauthorized)
		return
	}
	var token string
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		m := inTx(tx)
		pk, found, err := auth.PasskeyByCredential(ctx, m.auth, cred.ID)
		if err != nil {
			return err
		}
		if !found {
			return errNoPasskey
		}
		if err := auth.UsePasskey(ctx, m.auth, pk.ID, cred.Authenticator.SignCount, now); err != nil {
			return err
		}
		var deviceID int64
		if token, deviceID, err = auth.StartDevice(ctx, m.auth, human.ID, pk.ID, r.UserAgent(), false, now); err != nil {
			return err
		}
		return audit.Write(ctx, m.audit, now, audit.Entry{Actor: human.ID, Device: deviceID, Action: "device.login", TargetKind: "passkey", TargetID: pk.ID})
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
		m := inTx(tx)
		humanID, ok, err := auth.UseRecoveryCode(ctx, m.auth, in.Code, now)
		if err != nil {
			return err
		}
		if !ok {
			return errBadCode
		}
		var deviceID int64
		if token, deviceID, err = auth.StartDevice(ctx, m.auth, humanID, 0, r.UserAgent(), true, now); err != nil {
			return err
		}
		if err := audit.Write(ctx, m.audit, now, audit.Entry{Actor: humanID, Device: deviceID, Action: "recovery.used"}); err != nil {
			return err
		}
		_, err = event.Append(ctx, m.event, now, "recovery.used", map[string]any{"identity_id": humanID})
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
	setDeviceCookie(w, token, int(auth.DeviceIdle/time.Second))
	writeJSON(w, http.StatusOK, map[string]any{"limited": true})
}

var errBadCode = errors.New("recovery code not valid")

// ---- add a passkey -------------------------------------------------------------------------------

func (s *Server) registerOptions(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	existing, err := auth.ListPasskeys(r.Context(), s.readAuth(), c.human.ID)
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
	existing, err := auth.ListPasskeys(ctx, s.readAuth(), c.human.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	cred, err := auth.FinishRegistration(s.WA, c.human, existing, cer.Session, in.Credential)
	if err != nil {
		badCredential(w, http.StatusBadRequest)
		return
	}
	via := "session"
	if c.p.Limited {
		via = "recovery"
	}
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		m := inTx(tx)
		// A recovery device has no passkey to step up with; every other device must.
		if !c.p.Limited {
			if err := auth.ConsumeStepUp(ctx, m.auth, c.stepUp, c.dev.ID, "passkey.add", nil, now); err != nil {
				return err
			}
		}
		passkeyID, err := auth.AddPasskey(ctx, m.auth, c.human.ID, cred, passkeyLabel(now), via, now)
		if err != nil {
			return err
		}
		if err := audit.Write(ctx, m.audit, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "passkey.added", TargetKind: "passkey", TargetID: passkeyID, Detail: map[string]any{"via": via}}); err != nil {
			return err
		}
		_, err = event.Append(ctx, m.event, now, "passkey.added", map[string]any{"identity_id": c.human.ID, "passkey_id": passkeyID, "via": via})
		return err
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		writeErr(w, http.StatusForbidden, "step_up_invalid", "That passkey check is used up or expired. Check again.")
	case err != nil:
		s.internalError(w, r, err)
	default:
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
	passkeys, err := auth.ListPasskeys(r.Context(), s.readAuth(), c.human.ID)
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
	passkeys, err := auth.ListPasskeys(ctx, s.readAuth(), c.human.ID)
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
	var id int64
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		m := inTx(tx)
		if err := auth.UsePasskey(ctx, m.auth, pk.ID, cred.Authenticator.SignCount, now); err != nil {
			return err
		}
		var err error
		id, err = auth.IssueStepUp(ctx, m.auth, c.dev.ID, pk.ID, cer.Action, cer.TargetID, now)
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
		m := inTx(tx)
		if _, err := auth.RevokeDevice(ctx, m.auth, c.human.ID, c.dev.ID, "logout", now); err != nil {
			return err
		}
		return audit.Write(ctx, m.audit, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "device.logout"})
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	clearDeviceCookie(w)
	w.Header().Set("Clear-Site-Data", `"cache","cookies","storage"`)
	w.WriteHeader(http.StatusNoContent)
}
