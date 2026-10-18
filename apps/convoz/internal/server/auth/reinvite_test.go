package auth

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// auditLog is a journal that keeps the action of every audit line and the type of every event.
type auditLog struct{ actions, events []string }

func (l *auditLog) Audit(_ context.Context, _ pdb.DBTX, _ time.Time, e AuditEntry) error {
	l.actions = append(l.actions, e.Action)
	return nil
}
func (l *auditLog) Event(_ context.Context, _ pdb.DBTX, _ time.Time, typ string, _ map[string]any) error {
	l.events = append(l.events, typ)
	return nil
}

// reinviteWorld is a store with the owner, an old machine "box-2" that serves the agents named in served, and a pending login
// request from "box-2" for the handle asked.
type reinviteWorld struct {
	s       *pdb.Store
	owner   Human
	box     *KeyBox
	agents  *fakeAgents
	log     *auditLog
	ports   Ports
	oldID   int64
	request int64
}

func newReinviteWorld(t *testing.T, served []string, asked string) *reinviteWorld {
	t.Helper()
	box, err := NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	w := &reinviteWorld{s: dbtest.Store(t), box: box, agents: newFakeAgents(), log: &auditLog{}}
	w.owner = ownerRow(t, w.s)
	w.ports = Ports{Agents: w.agents, Journal: w.log}
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		w.oldID, err = CreateMachine(ctx, d, box, NewMachine{Name: "box-2", Scopes: DefaultScopes, Allow: Allow{Mode: AllowList}, ApprovedBy: w.owner.ID}, flowNow)
		if err != nil {
			return err
		}
		var ids []int64
		for _, h := range served {
			a, err := w.agents.Create(ctx, d, NewAgent{Handle: h, DisplayName: h, ByMachine: w.oldID}, flowNow)
			if err != nil {
				return err
			}
			ids = append(ids, a.ID)
		}
		if err := ReplaceAllow(ctx, d, w.oldID, Allow{Mode: AllowList, IdentityIDs: ids}); err != nil {
			return err
		}
		code, err := RequestDeviceCode(ctx, d, DeviceRequest{Name: "box-2", Source: "10.0.0.1", Interval: 5 * time.Second}, NewUserCode, flowNow)
		if err != nil {
			return err
		}
		w.request = code.RequestID
		return AttachLoginIdentity(ctx, d, code.RequestID, IdentityPackage{Handle: asked}, flowNow)
	}); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *reinviteWorld) revoke(handle string) {
	a := w.agents.byHandle[handle]
	a.Disabled = true
	w.agents.byHandle[handle] = a
}

func (w *reinviteWorld) approve(t *testing.T) (Machine, error) {
	t.Helper()
	var m Machine
	err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		m, err = ApproveRequest(ctx, d, w.box, w.ports, ApproveInput{RequestID: w.request, Scopes: DefaultScopes, Human: w.owner}, flowNow.Add(time.Minute))
		return err
	})
	return m, err
}

func (w *reinviteWorld) activeNamed(t *testing.T, name string) []Machine {
	t.Helper()
	var out []Machine
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		all, err := ListMachines(ctx, d, flowNow.Add(time.Minute))
		for _, m := range all {
			if m.Name == name {
				out = append(out, m)
			}
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestApprovingARevokedHandleBringsTheSameAgentBack(t *testing.T) {
	w := newReinviteWorld(t, []string{"dot"}, "dot")
	before := w.agents.byHandle["dot"]
	w.revoke("dot")

	m, err := w.approve(t)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}

	after := w.agents.byHandle["dot"]
	if after.ID != before.ID || after.Disabled {
		t.Fatalf("dot must come back as the same enabled identity: before %+v after %+v", before, after)
	}
	if len(w.agents.made) != 1 {
		t.Fatalf("no second dot may be made: %d creations", len(w.agents.made))
	}
	if !m.Allow.Covers(before.ID, "dot") {
		t.Fatalf("the new machine must be allowed to act as dot: %+v", m.Allow)
	}
	if m.ID == w.oldID {
		t.Fatal("the new machine must get its own key, not the old machine")
	}
	if named := w.activeNamed(t, "box-2"); len(named) != 1 || named[0].ID != m.ID {
		t.Fatalf("the old machine must be revoked and the new one the only box-2: %+v", named)
	}
	if !contains(w.log.actions, "identity.reenabled") || !contains(w.log.events, "identity.reenabled.v1") || !contains(w.log.actions, "machine.replaced") {
		t.Fatalf("missing audit or event: %v %v", w.log.actions, w.log.events)
	}
}

func TestAMachineThatServesAnActiveAgentKeepsItsName(t *testing.T) {
	w := newReinviteWorld(t, []string{"dot", "writer"}, "dot")
	w.revoke("dot")

	_, err := w.approve(t)

	if !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a machine that still serves writer must keep its name, got %v", err)
	}
	if named := w.activeNamed(t, "box-2"); len(named) != 1 || named[0].ID != w.oldID {
		t.Fatalf("the old machine must stay active: %+v", named)
	}
	if w.agents.byHandle["dot"].Disabled != true {
		t.Fatal("a refused approval must not bring dot back")
	}
}

func TestAMachineThatAllowsAnyAgentKeepsItsName(t *testing.T) {
	w := newReinviteWorld(t, []string{"dot"}, "dot")
	w.revoke("dot")
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error {
		return ReplaceAllow(ctx, d, w.oldID, Allow{Mode: AllowAny})
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := w.approve(t); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a machine that allows any agent must keep its name, got %v", err)
	}
}

func TestAnActiveHandleIsStillRefused(t *testing.T) {
	w := newReinviteWorld(t, []string{"writer"}, "writer")
	if err := dbtest.TxErr(t, w.s, func(ctx context.Context, d pdb.DBTX) error { // the name is free, so only the handle can refuse
		_, _, err := RevokeMachine(ctx, d, w.oldID, flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	_, err := w.approve(t)

	if !errors.Is(err, ErrHandleTaken) {
		t.Fatalf("an active agent handle must stay refused, got %v", err)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
