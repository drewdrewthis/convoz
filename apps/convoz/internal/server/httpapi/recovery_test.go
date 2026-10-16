package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// A recovery device lives 15 minutes and is revoked by its one passkey registration; the passkey it adds
// cannot remove others or regenerate codes until the 24 h window ends.
func TestRecoveryDeviceLifeAndItsPasskey(t *testing.T) {
	s := migratedStore(t)
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
	err = s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		_, err := registerPasskey(ctx, tx.DBTX(), c, "test", fakeCred("recovered"), now.Add(time.Minute))
		return err
	})
	if err != nil {
		t.Fatalf("a recovery device registers a passkey with no step-up: %v", err)
	}
	if look(now.Add(2 * time.Minute)) {
		t.Fatal("the recovery device must be revoked after one registration")
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
}

func authzLimited(h auth.Human, deviceID int64) authz.Principal {
	return authz.Principal{Authenticated: true, HumanID: h.ID, DeviceID: deviceID, Limited: true, Role: h.Role}
}

// Two verifies racing on one recovery device must not both add a passkey: the second finds the device ended.
func TestRecoveryDeviceRegistersOnlyOnePasskey(t *testing.T) {
	s := migratedStore(t)
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
