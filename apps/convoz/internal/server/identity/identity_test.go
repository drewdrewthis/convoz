package identity

import (
	"context"
	"errors"
	"strings"
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

// @voice is made once and found after; nobody makes or renames to its handle, and it cannot be renamed away (it is the built-in
// author of the owner's voice call).
func TestVoiceIsMadeOnceAndItsHandleIsReserved(t *testing.T) {
	s := dbtest.Store(t)
	now := time.Unix(1_800_000_000, 0)
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		owner, err := CreateOwner(ctx, d, "drew", "Drew", now)
		if err != nil {
			return err
		}
		first, err := Voice(ctx, d, owner.ID, now)
		if err != nil {
			return err
		}
		again, err := Voice(ctx, d, owner.ID, now)
		if err != nil {
			return err
		}
		if first.ID != again.ID || !IsBuiltin(again) || again.DisplayName != "Voice" {
			t.Errorf("first %+v, again %+v: want one built-in @voice named Voice", first, again)
		}
		if _, err := CreateAgent(ctx, d, NewAgent{Handle: "voice", DisplayName: "Not Voice", ByHuman: owner.ID}, now); !errors.Is(err, ErrInvalidHandle) {
			t.Errorf("an agent made as @voice: %v, want ErrInvalidHandle", err)
		}
		if _, err := CheckHandleChange(ctx, d, first.ID, "secretary", now); !errors.Is(err, ErrNotRenamable) {
			t.Errorf("@voice renamed: %v, want ErrNotRenamable", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// An agent changes its avatar later (crew.feature): the listed URL changes with the SVG, so no page shows the old picture from its
// image cache, and it goes away with the avatar.
func TestAChangedAvatarIsANewURL(t *testing.T) {
	s := dbtest.Store(t)
	now := time.Unix(1_800_000_000, 0)
	urlOf := func(ctx context.Context, d pdb.DBTX) string {
		all, err := List(ctx, d)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range all {
			if e.Handle == "dot" {
				return e.AvatarURL
			}
		}
		t.Fatal("dot is not listed")
		return ""
	}
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		owner, err := CreateOwner(ctx, d, "drew", "Drew", now)
		if err != nil {
			return err
		}
		a, err := CreateAgent(ctx, d, NewAgent{Handle: "dot", DisplayName: "Dot", ByHuman: owner.ID}, now)
		if err != nil {
			return err
		}
		if err := SetAvatar(ctx, d, a.ID, `<svg><circle r="4" fill="#c33"/></svg>`); err != nil {
			return err
		}
		first := urlOf(ctx, d)
		if err := SetAvatar(ctx, d, a.ID, `<svg><circle r="4" fill="#33c"/></svg>`); err != nil {
			return err
		}
		second := urlOf(ctx, d)
		if !strings.HasPrefix(first, "/api/identities/") || !strings.Contains(first, "/avatar.svg?v=") || first == second {
			t.Errorf("a changed avatar must be a new URL: %q then %q", first, second)
		}
		if err := SetAvatar(ctx, d, a.ID, ""); err != nil {
			return err
		}
		if gone := urlOf(ctx, d); gone != "" {
			t.Errorf("a removed avatar has no URL, got %q", gone)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
