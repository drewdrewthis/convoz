package auth

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Human is the part of a person that auth needs. The composition root fills it from the identity module.
type Human struct {
	ID          int64
	Handle      string
	DisplayName string
	Role        string
}

// RecoveryPasskeyDelay is how long a passkey added by recovery cannot do destructive things (I-26).
const RecoveryPasskeyDelay = 24 * time.Hour

// DestructiveActions are the step-up actions a passkey must be old enough for (I-26).
var DestructiveActions = map[string]bool{
	"passkey.remove":      true,
	"recovery.regenerate": true,
	"machine.reveal":      true,
	"machine.regenerate":  true, // it returns a key
	"machine.revoke":      true,
	"machine.approve":     true, // it hands a machine its key
	"machine.allow":       true, // it widens who a machine may act as
}

// ErrPasskeyTooNew means the passkey was added by recovery less than RecoveryPasskeyDelay ago.
var ErrPasskeyTooNew = errors.New("passkey is too new for this action")

// CheckDestructive refuses a step-up for a destructive action with a passkey that is still inside its delay.
func CheckDestructive(pk Passkey, action string, now time.Time) error {
	if DestructiveActions[action] && now.UnixMilli() < pk.DestructiveAt {
		return ErrPasskeyTooNew
	}
	return nil
}

// Passkey is a stored credential of a human.
type Passkey struct {
	ID             int64
	HumanID        int64
	Label          string
	RegisteredVia  string
	CreatedAt      int64
	LastUsedAt     *int64
	credential     webauthn.Credential
	DestructiveAt  int64
	BackupEligible bool
}

// NewRelyingParty configures WebAuthn: the RP ID is the host name, the origin is what browsers send,
// user verification is required, resident keys are preferred and attestation is not asked for.
func NewRelyingParty(rpID, origin string) (*webauthn.WebAuthn, error) {
	return webauthn.New(&webauthn.Config{
		RPID:                  rpID,
		RPDisplayName:         "Convoz",
		RPOrigins:             []string{origin},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationRequired,
		},
	})
}

// User is a webauthn.User for one human. The user handle is the human's handle: it never changes (I-3),
// so a resident credential found without a name still leads back to one human.
type User struct {
	human Human
	creds []webauthn.Credential
}

// NewUser builds the WebAuthn user for h with the given passkeys.
func NewUser(h Human, passkeys []Passkey) *User {
	u := &User{human: h}
	for _, p := range passkeys {
		u.creds = append(u.creds, p.credential)
	}
	return u
}

// WebAuthnID implements webauthn.User.
func (u *User) WebAuthnID() []byte { return []byte(u.human.Handle) }

// WebAuthnName implements webauthn.User.
func (u *User) WebAuthnName() string { return u.human.Handle }

// WebAuthnDisplayName implements webauthn.User.
func (u *User) WebAuthnDisplayName() string { return u.human.DisplayName }

// WebAuthnCredentials implements webauthn.User.
func (u *User) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func descriptors(passkeys []Passkey) []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(passkeys))
	for _, p := range passkeys {
		out = append(out, protocol.CredentialDescriptor{Type: protocol.PublicKeyCredentialType, CredentialID: p.credential.ID})
	}
	return out
}

// BeginRegistration starts adding a passkey for h; existing passkeys are excluded.
func BeginRegistration(wa *webauthn.WebAuthn, h Human, existing []Passkey) (*protocol.CredentialCreation, *webauthn.SessionData, error) {
	return wa.BeginRegistration(NewUser(h, existing), webauthn.WithExclusions(descriptors(existing)))
}

// FinishRegistration checks the browser's answer (the JSON of PublicKeyCredential.toJSON()).
func FinishRegistration(wa *webauthn.WebAuthn, h Human, existing []Passkey, sd webauthn.SessionData, credentialJSON []byte) (*webauthn.Credential, error) {
	parsed, err := protocol.ParseCredentialCreationResponseBytes(credentialJSON)
	if err != nil {
		return nil, err
	}
	return wa.CreateCredential(NewUser(h, existing), sd, parsed)
}

// BeginDiscoverableLogin starts a sign-in where the authenticator picks the passkey.
func BeginDiscoverableLogin(wa *webauthn.WebAuthn) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	return wa.BeginDiscoverableLogin()
}

// Lookup finds the human and the passkeys for a discoverable sign-in by user handle.
type Lookup func(ctx context.Context, userHandle []byte) (Human, []Passkey, error)

// FinishDiscoverableLogin checks a sign-in answer. It returns the human and the passkey used;
// a counter that did not advance (a cloned authenticator) is refused.
func FinishDiscoverableLogin(ctx context.Context, wa *webauthn.WebAuthn, sd webauthn.SessionData, credentialJSON []byte, lookup Lookup) (Human, *webauthn.Credential, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBytes(credentialJSON)
	if err != nil {
		return Human{}, nil, err
	}
	var human Human
	handler := func(_, userHandle []byte) (webauthn.User, error) {
		h, passkeys, err := lookup(ctx, userHandle)
		if err != nil {
			return nil, err
		}
		human = h
		return NewUser(h, passkeys), nil
	}
	_, cred, err := wa.ValidatePasskeyLogin(handler, sd, parsed)
	if err != nil {
		return Human{}, nil, err
	}
	if cred.Authenticator.CloneWarning {
		return Human{}, nil, errors.New("signature counter did not advance")
	}
	return human, cred, nil
}

// BeginStepUp starts an assertion limited to h's own passkeys.
func BeginStepUp(wa *webauthn.WebAuthn, h Human, passkeys []Passkey) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	return wa.BeginLogin(NewUser(h, passkeys))
}

// FinishStepUp checks a step-up answer against h's passkeys.
func FinishStepUp(wa *webauthn.WebAuthn, h Human, passkeys []Passkey, sd webauthn.SessionData, credentialJSON []byte) (*webauthn.Credential, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBytes(credentialJSON)
	if err != nil {
		return nil, err
	}
	cred, err := wa.ValidateLogin(NewUser(h, passkeys), sd, parsed)
	if err != nil {
		return nil, err
	}
	if cred.Authenticator.CloneWarning {
		return nil, errors.New("signature counter did not advance")
	}
	return cred, nil
}

func fromRow(id, humanID int64, credID, pub, aaguid []byte, signCount int64, backup int64, label, via string, destructive, created int64, last sql.NullInt64) Passkey {
	p := Passkey{ID: id, HumanID: humanID, Label: label, RegisteredVia: via, CreatedAt: created, DestructiveAt: destructive, BackupEligible: backup == 1}
	if last.Valid {
		p.LastUsedAt = &last.Int64
	}
	p.credential = webauthn.Credential{
		ID:        credID,
		PublicKey: pub,
		Flags:     webauthn.CredentialFlags{UserPresent: true, UserVerified: true, BackupEligible: backup == 1},
		Authenticator: webauthn.Authenticator{
			AAGUID:    aaguid,
			SignCount: uint32(signCount),
		},
	}
	return p
}

// ListPasskeys returns h's active passkeys, oldest first.
func ListPasskeys(ctx context.Context, d pdb.DBTX, humanID int64) ([]Passkey, error) {
	q := db.New(d)
	rows, err := q.ListActivePasskeys(ctx, humanID)
	if err != nil {
		return nil, err
	}
	out := make([]Passkey, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.HumanID, r.CredentialID, r.PublicKey, r.Aaguid, r.SignCount, r.BackupEligible, r.Label, r.RegisteredVia, r.DestructiveStepUpAfter, r.CreatedAt, r.LastUsedAt))
	}
	return out, nil
}

// PasskeyByCredential finds an active passkey by credential id; ok is false when there is none.
func PasskeyByCredential(ctx context.Context, d pdb.DBTX, credentialID []byte) (Passkey, bool, error) {
	q := db.New(d)
	r, err := q.GetActivePasskeyByCredential(ctx, credentialID)
	if errors.Is(err, sql.ErrNoRows) {
		return Passkey{}, false, nil
	}
	if err != nil {
		return Passkey{}, false, err
	}
	return fromRow(r.ID, r.HumanID, r.CredentialID, r.PublicKey, r.Aaguid, r.SignCount, r.BackupEligible, r.Label, r.RegisteredVia, r.DestructiveStepUpAfter, r.CreatedAt, r.LastUsedAt), true, nil
}

// AddPasskey stores a new passkey. via is "bootstrap", "session" or "recovery"; a recovery passkey
// cannot do destructive things for 24 hours. heldUntil (unix ms, 0 for none) carries the hold of the passkey
// that added this one, so a held passkey cannot launder its hold by adding a fresh one (I-26).
func AddPasskey(ctx context.Context, d pdb.DBTX, humanID int64, cred *webauthn.Credential, label, via string, heldUntil int64, now time.Time) (int64, error) {
	q := db.New(d)
	after := max(now.UnixMilli(), heldUntil)
	if via == "recovery" {
		after = max(after, now.Add(RecoveryPasskeyDelay).UnixMilli())
	}
	backup := int64(0)
	if cred.Flags.BackupEligible {
		backup = 1
	}
	return q.InsertPasskey(ctx, db.InsertPasskeyParams{
		HumanID:                humanID,
		CredentialID:           cred.ID,
		PublicKey:              cred.PublicKey,
		SignCount:              int64(cred.Authenticator.SignCount),
		Aaguid:                 cred.Authenticator.AAGUID,
		BackupEligible:         backup,
		Label:                  label,
		RegisteredVia:          via,
		DestructiveStepUpAfter: after,
		CreatedAt:              now.UnixMilli(),
	})
}

// UsePasskey records a successful assertion: the new counter and the time.
func UsePasskey(ctx context.Context, d pdb.DBTX, id int64, signCount uint32, now time.Time) error {
	q := db.New(d)
	return q.TouchPasskey(ctx, db.TouchPasskeyParams{SignCount: int64(signCount), LastUsedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id})
}

// ErrLastPasskey means removing the passkey would leave the human with none (I-26).
var ErrLastPasskey = errors.New("another passkey must be added first")

// ErrNoPasskey means the passkey does not exist or is already removed.
var ErrNoPasskey = errors.New("passkey not found")

// RemovePasskey revokes a passkey and signs out the devices that came from it.
// The last active passkey is refused.
func RemovePasskey(ctx context.Context, d pdb.DBTX, humanID, passkeyID int64, now time.Time) error {
	q := db.New(d)
	n, err := q.CountActivePasskeys(ctx, humanID)
	if err != nil {
		return err
	}
	if n <= 1 {
		// Distinguish "no such passkey" from "the only one" so a wrong id is not told "last passkey".
		keys, err := ListPasskeys(ctx, d, humanID)
		if err != nil {
			return err
		}
		for _, k := range keys {
			if k.ID == passkeyID {
				return ErrLastPasskey
			}
		}
		return ErrNoPasskey
	}
	rows, err := q.RevokePasskey(ctx, db.RevokePasskeyParams{RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: passkeyID, HumanID: humanID})
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNoPasskey
	}
	return q.RevokeDevicesOfPasskey(ctx, db.RevokeDevicesOfPasskeyParams{RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, PasskeyID: sql.NullInt64{Int64: passkeyID, Valid: true}})
}

// FindPasskey picks the passkey with this credential id out of a list.
func FindPasskey(passkeys []Passkey, credentialID []byte) (Passkey, bool) {
	for _, p := range passkeys {
		if bytes.Equal(p.credential.ID, credentialID) {
			return p, true
		}
	}
	return Passkey{}, false
}
