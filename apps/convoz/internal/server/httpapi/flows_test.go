package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func TestClipKeepsPrintableASCIIOnly(t *testing.T) {
	got := clip("a‮b\x00c\tdé" + strings.Repeat("x", 40))
	if want := "abcd" + strings.Repeat("x", hostInfoLimit-4); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestMarkupInHostInfoStaysUnderTheColumnLimit(t *testing.T) {
	nasty := strings.Repeat(`<>&"\`, 40)
	info, err := json.Marshal(wire.HostInfo{Hostname: clip(nasty), OS: clip(nasty), Arch: clip(nasty), CLIVersion: clip(nasty)})
	if err != nil {
		t.Fatal(err)
	}
	if len(info) >= 200 || strings.ContainsAny(string(info), `<>&\`) {
		t.Fatalf("%d bytes: %s", len(info), info)
	}
}

// The one httpapi test through the real flowPorts: the identity lookup, creation and the per-machine count are
// the ports' own queries, which the in-memory fakes in auth's tests cannot exercise.
func TestMintThroughRealPortsCreatesAndCountsAgents(t *testing.T) {
	s := dbtest.Store(t)
	now := time.Unix(1_800_000_000, 0)
	var owner identity.Human
	var key string
	err := s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var err error
		if owner, err = identity.CreateOwner(ctx, d, "drew", "Drew", now); err != nil {
			return err
		}
		box, err := auth.NewKeyBox(bytes.Repeat([]byte{7}, 32))
		if err != nil {
			return err
		}
		id, err := auth.CreateMachine(ctx, d, box, auth.NewMachine{Name: "box-1", Scopes: auth.DefaultScopes | auth.ScopeCreateIdentity, Allow: auth.Allow{Mode: auth.AllowAny}, ApprovedBy: owner.ID}, now)
		if err != nil {
			return err
		}
		key, err = auth.RevealKey(ctx, d, box, id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	mint := func(as string, create bool) error {
		req := auth.MintRequest{MachineKey: key, As: as, ClientID: "client-001"}
		if create {
			req.Create = &auth.CreateIdentity{DisplayName: strings.ToUpper(as[:1]) + as[1:]}
		}
		return s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
			_, err := auth.MintSession(ctx, tx.DBTX(), flowPorts, req, now)
			return err
		})
	}
	if err := mint("alpha", true); err != nil {
		t.Fatalf("create and start: %v", err)
	}
	if err := mint("alpha", false); err != nil {
		t.Fatalf("find the agent it made: %v", err)
	}
	var forbidden auth.ForbiddenError
	if err := mint("drew", false); !errors.As(err, &forbidden) {
		t.Fatalf("a human cannot start a session: %v", err)
	}
	var field *auth.FieldError
	if err := mint("x", false); !errors.As(err, &field) {
		t.Fatalf("a bad handle names its field: %v", err)
	}
	for _, n := range []string{"bravo", "charlie", "delta", "echo"} {
		if err := mint(n, true); err != nil {
			t.Fatalf("create %s: %v", n, err)
		}
	}
	var limited *auth.RateLimitedError
	if err := mint("foxtrot", true); !errors.As(err, &limited) {
		t.Fatalf("a sixth identity in a day, counted by the real port: %v", err)
	}
}
