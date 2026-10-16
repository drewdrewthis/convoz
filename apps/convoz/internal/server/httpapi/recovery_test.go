package httpapi

import (
	"context"
	"errors"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// A recovery device lives 15 minutes and is revoked by its one passkey registration; that registration starts a
// full device session for the new passkey, which cannot remove others or regenerate codes until the 24 h window ends.
func TestRecoveryDeviceLifeAndItsPasskey(t *testing.T) {
	s := dbtest.Store(t)
	now := platform.SystemClock{}.Now()
	owner, err := runBootstrap(s, bootstrapPorts, mintLink(t, s, now), "first", now)
	if err != nil {
		t.Fatal(err)
	}
	human := owner.Owner

	var token string
	var devID int64
	err = s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		token, devID, err = auth.StartDevice(ctx, tx.DBTX(), human.ID, 0, "test", true, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	look := func(at time.Time) bool {
		_, ok, err := auth.LookupDevice(context.Background(), s.Reader.SQL(), token, at)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !look(now.Add(auth.RecoveryDeviceTTL-time.Second)) || look(now.Add(auth.RecoveryDeviceTTL+time.Second)) {
		t.Fatal("a recovery device must live exactly 15 minutes")
	}

	c := &call{p: authzLimited(human, devID), dev: auth.Device{ID: devID, HumanID: human.ID, Limited: true}, human: human}
	var res auth.RegisterResult
	err = s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		res, err = registerPasskey(ctx, tx.DBTX(), c, "test", fakeCred("recovered"), now.Add(time.Minute))
		return err
	})
	if err != nil {
		t.Fatalf("a recovery device registers a passkey with no step-up: %v", err)
	}
	if look(now.Add(2 * time.Minute)) {
		t.Fatal("the recovery device must be revoked after one registration")
	}
	if res.DeviceToken == "" {
		t.Fatal("recovery must hand back a full device token")
	}
	full, ok, err := auth.LookupDevice(context.Background(), s.Reader.SQL(), res.DeviceToken, now.Add(2*time.Minute))
	if err != nil || !ok || full.Limited || full.PasskeyID != res.PasskeyID || full.ID == devID {
		t.Fatalf("the new session must be a full device for the new passkey: %+v ok=%v err=%v", full, ok, err)
	}
	var detail string
	if err := s.Reader.SQL().QueryRow(`SELECT detail_json FROM audit WHERE action = 'device.login' AND device_id = ?`, full.ID).Scan(&detail); err != nil || detail != `{"via":"recovery"}` {
		t.Fatalf("device.login must name the new device with via=recovery: %q %v", detail, err)
	}
	keys, err := auth.ListPasskeys(context.Background(), s.Reader.SQL(), human.ID)
	if err != nil {
		t.Fatal(err)
	}
	pk, ok := auth.FindPasskey(keys, fakeCred("recovered").ID)
	if !ok || pk.RegisteredVia != "recovery" {
		t.Fatalf("recovery passkey missing: %+v", keys)
	}
	at := now.Add(2 * time.Hour)
	if auth.CheckDestructive(pk, "passkey.remove", at) == nil || auth.CheckDestructive(pk, "recovery.regenerate", at) == nil {
		t.Fatal("a recovery-added passkey must not do destructive things inside 24 h")
	}
	if auth.CheckDestructive(pk, "passkey.remove", now.Add(25*time.Hour)) != nil {
		t.Fatal("the window must end")
	}
	// The held passkey adds another one from its full session: the new passkey is held until the same time.
	c2 := &call{p: authz.Principal{Authenticated: true, HumanID: human.ID, DeviceID: full.ID, Role: human.Role}, dev: full, human: human}
	err = s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		if c2.stepUp, err = auth.IssueStepUp(ctx, tx.DBTX(), full.ID, pk.ID, "passkey.add", nil, at); err != nil {
			return err
		}
		_, err = registerPasskey(ctx, tx.DBTX(), c2, "test", fakeCred("from-held"), at)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	keys, err = auth.ListPasskeys(context.Background(), s.Reader.SQL(), human.ID)
	if err != nil {
		t.Fatal(err)
	}
	child, ok := auth.FindPasskey(keys, fakeCred("from-held").ID)
	if !ok || child.RegisteredVia != "session" || child.DestructiveAt != pk.DestructiveAt {
		t.Fatalf("a passkey added from a held device must be held until the same time: %+v", child)
	}
	if auth.CheckDestructive(child, "machine.reveal", at) == nil || auth.CheckDestructive(child, "machine.reveal", now.Add(25*time.Hour)) != nil {
		t.Fatal("the inherited hold must refuse inside the window and end with it")
	}
	note, err := auth.RecoveryNote(context.Background(), s.Reader.SQL(), human.ID, full.PasskeyID, at)
	if err != nil || note == nil || note.HoldUntil == nil || *note.HoldUntil != pk.DestructiveAt {
		t.Fatalf("the recovery note must say when the hold ends: %+v %v", note, err)
	}
	if n, err := auth.RecoveryNote(context.Background(), s.Reader.SQL(), human.ID, child.ID, at); err != nil || n != nil {
		t.Fatalf("the banner says a recovery code was used, so a session-added passkey gets none: %+v %v", n, err)
	}
}

func authzLimited(h auth.Human, deviceID int64) authz.Principal {
	return authz.Principal{Authenticated: true, HumanID: h.ID, DeviceID: deviceID, Limited: true, Role: h.Role}
}

// Two verifies racing on one recovery device must not both add a passkey: the second finds the device ended.
func TestRecoveryDeviceRegistersOnlyOnePasskey(t *testing.T) {
	s := dbtest.Store(t)
	now := platform.SystemClock{}.Now()
	owner, err := runBootstrap(s, bootstrapPorts, mintLink(t, s, now), "first", now)
	if err != nil {
		t.Fatal(err)
	}
	human := owner.Owner
	var devID int64
	err = s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		_, devID, err = auth.StartDevice(ctx, tx.DBTX(), human.ID, 0, "test", true, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	c := &call{p: authzLimited(human, devID), dev: auth.Device{ID: devID, HumanID: human.ID, Limited: true}, human: human}
	register := func(id string) error {
		return s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
			_, err := registerPasskey(ctx, tx.DBTX(), c, "test", fakeCred(id), now.Add(time.Minute))
			return err
		})
	}
	if err := register("one"); err != nil {
		t.Fatal(err)
	}
	if err := register("two"); !errors.Is(err, auth.ErrDeviceGone) {
		t.Fatalf("the second registration on the same recovery device: %v", err)
	}
	if n := count(t, s, "passkeys"); n != 2 { // the bootstrap passkey and the first recovery one
		t.Fatalf("passkeys: %d", n)
	}
}
