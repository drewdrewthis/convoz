package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

func TestValidDisplayNameRejectsFormatCharacters(t *testing.T) {
	cases := map[string]bool{
		"Dev Tool":      true,
		"Café":          true,
		"":              false,
		"   ":           false,
		"Dev‮Tool":      false, // right-to-left override
		"Dev​Tool":      false, // zero-width space
		"Dev⁦Tool":      false, // isolate
		"Dev\u0007Tool": false, // control
	}
	for name, want := range cases {
		if got := ValidDisplayName(name); got != want {
			t.Errorf("ValidDisplayName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestAReenabledAgentIsTheSameIdentity(t *testing.T) {
	s := dbtest.Store(t)
	now := time.Unix(1_800_000_000, 0)
	var id int64
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		owner, err := CreateOwner(ctx, d, "drew", "Drew", now)
		if err != nil {
			return err
		}
		a, err := CreateAgent(ctx, d, NewAgent{Handle: "dot", DisplayName: "Dot", ByHuman: owner.ID}, now)
		if err != nil {
			return err
		}
		id = a.ID
		return errors.Join(err, errOnFalse(DisableAgent(ctx, d, id, now)))
	}); err != nil {
		t.Fatal(err)
	}
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if _, err := CreateAgent(ctx, d, NewAgent{Handle: "dot", DisplayName: "Dot 2"}, now); !errors.Is(err, ErrHandleTaken) {
			t.Fatalf("a revoked handle is not free for a new agent: %v", err)
		}
		ok, err := ReenableAgent(ctx, d, id, Reintro{DisplayName: "Dotty", Description: "back again"})
		if err != nil || !ok {
			t.Fatalf("reenable: %v %v", ok, err)
		}
		p, found, err := Lookup(ctx, d, "dot")
		if err != nil || !found || p.ID != id || p.Disabled || p.DisplayName != "Dotty" {
			t.Fatalf("dot must be the same enabled identity with the new name: %+v %v", p, err)
		}
		if again, err := ReenableAgent(ctx, d, id, Reintro{}); err != nil || again {
			t.Fatalf("an enabled agent cannot be brought back again: %v %v", again, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func errOnFalse(ok bool, err error) error {
	if err == nil && !ok {
		return errors.New("not disabled")
	}
	return err
}
