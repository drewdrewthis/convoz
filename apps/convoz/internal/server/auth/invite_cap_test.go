package auth

import (
	"bytes"
	"context"
	"errors"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// An agent holds three open invites and the owner ten; the cap is per maker.
func TestAnAgentHoldsThreeOpenInvites(t *testing.T) {
	s := dbtest.Store(t)
	owner := ownerRow(t, s)
	fa := newFakeAgents()
	ports := Ports{Agents: fa, Journal: fakeJournal{}}
	var agent Agent
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		box, err := NewKeyBox(bytes.Repeat([]byte{7}, 32))
		if err != nil {
			return err
		}
		machine, err := CreateMachine(ctx, d, box, NewMachine{Name: "box-2", Scopes: DefaultScopes, Allow: Allow{Mode: AllowList}, ApprovedBy: owner.ID}, flowNow)
		if err != nil {
			return err
		}
		agent, err = fa.Create(ctx, d, NewAgent{Handle: "claude", DisplayName: "Claude", ByMachine: machine}, flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	make := func(maker int64) error {
		return dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, _, err := CreateInvite(ctx, d, ports, NewInvite{By: AuditEntry{Actor: maker}}, flowNow)
			return err
		})
	}
	for i := 0; i < MaxOpenAgentInvites; i++ {
		if err := make(agent.ID); err != nil {
			t.Fatalf("agent invite %d: %v", i+1, err)
		}
	}
	if err := make(agent.ID); !errors.Is(err, ErrInviteCap) {
		t.Fatalf("4th agent invite: got %v, want ErrInviteCap", err)
	}
	for i := 0; i < MaxOpenInvites; i++ {
		if err := make(owner.ID); err != nil {
			t.Fatalf("owner invite %d: %v", i+1, err)
		}
	}
	if err := make(owner.ID); !errors.Is(err, ErrInviteCap) {
		t.Fatalf("11th owner invite: got %v, want ErrInviteCap", err)
	}
}
