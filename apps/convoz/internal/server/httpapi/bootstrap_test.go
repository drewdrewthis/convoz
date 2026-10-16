package httpapi

import (
	"context"
	"errors"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func fakeCred(id string) *webauthn.Credential {
	return &webauthn.Credential{ID: []byte("TESTONLY-" + id), PublicKey: []byte("TESTONLY-key-" + id)}
}

func mintLink(t *testing.T, s *pdb.Store, now time.Time) string {
	t.Helper()
	var token string
	err := s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		token, _, err = auth.MintBootstrapLink(ctx, tx.DBTX(), now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func runBootstrap(s *pdb.Store, ports auth.BootstrapPorts, token, id string, now time.Time) (auth.BootstrapResult, error) {
	var res auth.BootstrapResult
	err := s.Writer.Tx(context.Background(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		res, err = auth.Bootstrap(ctx, tx.DBTX(), ports, auth.BootstrapInput{Token: token, Handle: "drew", DisplayName: "Drew", UserAgent: "test", Credential: fakeCred(id)}, now)
		return err
	})
	return res, err
}

func count(t *testing.T, s *pdb.Store, table string) int {
	t.Helper()
	var n int
	if err := s.Reader.SQL().QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type failingJournal struct{ journalPort }

func (failingJournal) Event(context.Context, pdb.DBTX, time.Time, string, map[string]any) error {
	return errors.New("event log is down")
}

func TestBootstrapMakesTheOwnerOnce(t *testing.T) {
	s := dbtest.Store(t)
	now := platform.SystemClock{}.Now()

	first, err := runBootstrap(s, bootstrapPorts, mintLink(t, s, now), "one", now)
	if err != nil || first.State != auth.LinkOK {
		t.Fatalf("first bootstrap: %v state=%v", err, first.State)
	}
	if !first.Created || first.Owner.Handle != "drew" || len(first.RecoveryCodes) != auth.RecoveryCodeCount || first.DeviceToken == "" {
		t.Fatalf("first bootstrap result: %+v", first)
	}
	if count(t, s, "audit") != 1 || count(t, s, "events") != 2 || count(t, s, "passkeys") != 1 {
		t.Fatalf("rows: audit=%d events=%d passkeys=%d", count(t, s, "audit"), count(t, s, "events"), count(t, s, "passkeys"))
	}

	// A second link adds a passkey to the same owner: no new owner, no new codes, the typed name is ignored.
	second, err := runBootstrap(s, bootstrapPorts, mintLink(t, s, now), "two", now)
	if err != nil || second.Created || len(second.RecoveryCodes) != 0 || second.Owner.ID != first.Owner.ID {
		t.Fatalf("second bootstrap: %v %+v", err, second)
	}
	if count(t, s, "passkeys") != 2 || count(t, s, "identities") != 1 {
		t.Fatalf("second link: passkeys=%d identities=%d", count(t, s, "passkeys"), count(t, s, "identities"))
	}
}

func TestBootstrapRefusesUsedUnknownAndExpiredLinks(t *testing.T) {
	s := dbtest.Store(t)
	now := platform.SystemClock{}.Now()
	token := mintLink(t, s, now)
	if _, err := runBootstrap(s, bootstrapPorts, token, "one", now); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		token string
		at    time.Time
		want  auth.LinkState
	}{
		"used":    {token, now, auth.LinkUsed},
		"unknown": {"cvz_b_TESTONLYnope", now, auth.LinkUnknown},
		"expired": {mintLink(t, s, now), now.Add(auth.BootstrapTTL + time.Second), auth.LinkExpired},
	}
	for name, c := range cases {
		before := count(t, s, "passkeys")
		res, err := runBootstrap(s, bootstrapPorts, c.token, name, c.at)
		if err != nil || res.State != c.want {
			t.Fatalf("%s: err=%v state=%v want %v", name, err, res.State, c.want)
		}
		if count(t, s, "passkeys") != before {
			t.Fatalf("%s: a refused link registered a passkey", name)
		}
	}
}

func TestBootstrapRollsBackWhenAPortFails(t *testing.T) {
	s := dbtest.Store(t)
	now := platform.SystemClock{}.Now()
	token := mintLink(t, s, now)
	ports := auth.BootstrapPorts{Owners: ownerPort{}, Journal: failingJournal{}}
	if _, err := runBootstrap(s, ports, token, "one", now); err == nil {
		t.Fatal("a failing event port must fail the flow")
	}
	owners, _ := identity.List(context.Background(), s.Reader.SQL())
	if len(owners) != 0 || count(t, s, "passkeys") != 0 || count(t, s, "audit") != 0 || count(t, s, "recovery_codes") != 0 {
		t.Fatal("a failed bootstrap left rows behind")
	}
	if _, state, _ := auth.CheckBootstrapLink(context.Background(), s.Reader.SQL(), token, now); state != auth.LinkOK {
		t.Fatalf("the link must stay unused after a rollback, got state %v", state)
	}
	if res, err := runBootstrap(s, bootstrapPorts, token, "retry", now); err != nil || !res.Created {
		t.Fatalf("retry after rollback: %v %+v", err, res)
	}
}
