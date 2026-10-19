package auth

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// boxWorld is a reinviteWorld whose "box-2" machine, serving "writer", was approved from the node "node-a".
func boxWorld(t *testing.T) *reinviteWorld {
	t.Helper()
	w := newReinviteWorld(t, []string{"writer"}, "dot")
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error { return setMachineSource(ctx, d, w.oldID, "node-a") }); err != nil {
		t.Fatal(err)
	}
	return w
}

// askFrom files a login request named "box-2" for handle from node and makes it the world's current request. It returns the device code.
func (w *reinviteWorld) askFrom(t *testing.T, node, handle string) string {
	t.Helper()
	var code DeviceCode
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		code, err = RequestDeviceCode(ctx, d, DeviceRequest{Name: "box-2", Source: "100.64.0.1", SourceNode: node, Interval: 5 * time.Second}, NewUserCode, flowNow)
		if err != nil {
			return err
		}
		w.request = code.RequestID
		return AttachLoginIdentity(ctx, d, code.RequestID, IdentityPackage{Handle: handle}, flowNow)
	}); err != nil {
		t.Fatal(err)
	}
	return code.DeviceCode
}

// fillCap makes active machines until MaxActiveMachines are active.
func (w *reinviteWorld) fillCap(t *testing.T) {
	t.Helper()
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		for i := 1; i < MaxActiveMachines; i++ {
			if _, err := CreateMachine(ctx, d, w.box, NewMachine{Name: fmt.Sprintf("other-%d", i), Scopes: DefaultScopes, Allow: Allow{Mode: AllowList}, ApprovedBy: w.owner.ID}, flowNow); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// Owner msgs 772, 774, 775: a second agent on a connected box shares the box's machine and key.
func TestASecondAgentFromTheSameNodeJoinsTheMachineAndGetsItsKey(t *testing.T) {
	w := boxWorld(t)
	w.fillCap(t) // joining makes no machine, so the cap is not touched
	var oldKey string
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		oldKey, err = RevealKey(ctx, d, w.box, w.oldID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	for _, handle := range []string{"dot", "ink"} { // the third agent joins too
		device := w.askFrom(t, "node-a", handle)
		m, err := w.approve(t)
		if err != nil || m.ID != w.oldID {
			t.Fatalf("%s must join machine %d, got %d, %v", handle, w.oldID, m.ID, err)
		}
		if !m.Allow.Covers(w.agents.byHandle[handle].ID, handle) {
			t.Fatalf("the machine must be allowed to act as %s: %+v", handle, m.Allow)
		}
		var polled PollResult
		if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
			var err error
			polled, err = PollDeviceCode(ctx, d, w.box, device, flowNow.Add(2*time.Minute))
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if polled.Outcome != PollApproved || polled.Key != oldKey || polled.MachineID != w.oldID {
			t.Fatalf("%s must get the existing key of machine %d: %+v", handle, w.oldID, polled)
		}
	}
	if named := w.activeNamed(t, "box-2"); len(named) != 1 {
		t.Fatalf("no second machine may be made: %+v", named)
	}
}

func TestARequestFromAnotherNodeWithTheSameNameIsStillRefused(t *testing.T) {
	w := boxWorld(t)
	w.askFrom(t, "node-b", "dot")

	_, err := w.approve(t)

	if !errors.Is(err, ErrNameTaken) {
		t.Fatalf("another node must not get the shared key, got %v", err)
	}
	if named := w.activeNamed(t, "box-2"); len(named) != 1 || named[0].ID != w.oldID {
		t.Fatalf("the machine must be as it was: %+v", named)
	}
}
