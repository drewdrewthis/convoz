package auth

import (
	"context"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// OwnerPort is what the first-owner flow needs from the identity module. The composition root implements it.
type OwnerPort interface {
	// Owner returns the owner; ok is false before the first bootstrap.
	Owner(ctx context.Context, d pdb.DBTX) (h Human, ok bool, err error)
	CreateOwner(ctx context.Context, d pdb.DBTX, handle, displayName string, now time.Time) (Human, error)
}

// AuditEntry is one audit line, as auth sees it (the audit module owns the row).
type AuditEntry struct {
	Actor, Device int64
	Machine       int64
	Session       int64
	Action        string
	TargetKind    string
	TargetID      int64
	Detail        map[string]any
}

// JournalPort records an action in the audit table and the event log, in the caller's transaction.
type JournalPort interface {
	Audit(ctx context.Context, d pdb.DBTX, now time.Time, e AuditEntry) error
	Event(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload map[string]any) error
}

// BootstrapPorts are the other modules the bootstrap flow writes through.
type BootstrapPorts struct {
	Owners  OwnerPort
	Journal JournalPort
}

// BootstrapInput is a verified first passkey plus the link that allows it.
type BootstrapInput struct {
	Token       string
	Handle      string // used only when no owner exists yet
	DisplayName string
	UserAgent   string
	Credential  *webauthn.Credential
}

// BootstrapResult is what the caller answers with. State is LinkOK when the flow ran.
type BootstrapResult struct {
	State         LinkState
	Owner         Human
	Created       bool     // the owner was made by this call
	RecoveryCodes []string // only when Created; shown once
	DeviceToken   string   // the new device cookie value
}

// PasskeyLabel is the default name of a passkey added at now.
func PasskeyLabel(now time.Time) string { return "Passkey " + now.UTC().Format("2006-01-02") }

// Bootstrap spends a bootstrap link on a passkey: it makes the owner when there is none (with recovery
// codes), adds the passkey, signs the device in, and writes the audit line and events. Call it inside
// one write transaction so an error leaves nothing behind. A link that is unknown, used or expired
// returns its state and changes nothing; a race for the link returns ErrLinkUsed.
func Bootstrap(ctx context.Context, d pdb.DBTX, p BootstrapPorts, in BootstrapInput, now time.Time) (BootstrapResult, error) {
	linkID, state, err := CheckBootstrapLink(ctx, d, in.Token, now)
	if err != nil || state != LinkOK {
		return BootstrapResult{State: state}, err
	}
	res := BootstrapResult{State: LinkOK}
	owner, ok, err := p.Owners.Owner(ctx, d)
	if err != nil {
		return res, err
	}
	if !ok {
		res.Created = true
		if owner, err = p.Owners.CreateOwner(ctx, d, in.Handle, in.DisplayName, now); err != nil {
			return res, err
		}
	}
	res.Owner = owner
	passkeyID, err := AddPasskey(ctx, d, owner.ID, in.Credential, PasskeyLabel(now), "bootstrap", now)
	if err != nil {
		return res, err
	}
	if err := UseBootstrapLink(ctx, d, linkID, passkeyID, now); err != nil {
		return res, err
	}
	if res.Created {
		if res.RecoveryCodes, err = NewRecoveryCodes(ctx, d, owner.ID, now); err != nil {
			return res, err
		}
	}
	var deviceID int64
	if res.DeviceToken, deviceID, err = StartDevice(ctx, d, owner.ID, passkeyID, in.UserAgent, false, now); err != nil {
		return res, err
	}
	if err := p.Journal.Audit(ctx, d, now, AuditEntry{Actor: owner.ID, Device: deviceID, Action: "bootstrap.used", TargetKind: "passkey", TargetID: passkeyID}); err != nil {
		return res, err
	}
	if res.Created {
		if err := p.Journal.Event(ctx, d, now, "owner.created", map[string]any{"identity_id": owner.ID}); err != nil {
			return res, err
		}
	}
	return res, p.Journal.Event(ctx, d, now, "passkey.added", map[string]any{"identity_id": owner.ID, "passkey_id": passkeyID, "via": "bootstrap"})
}
