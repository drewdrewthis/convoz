package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

var flowNow = time.Unix(1_800_000_000, 0)

func inTx(t *testing.T, s *pdb.Store, fn func(ctx context.Context, d pdb.DBTX) error) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error { return fn(ctx, tx.DBTX()) })
}

func request(t *testing.T, s *pdb.Store, source string, now time.Time) (auth.DeviceCode, error) {
	t.Helper()
	var out auth.DeviceCode
	err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		out, err = auth.RequestDeviceCode(ctx, d, auth.DeviceRequest{Name: "box-2", Source: source, Interval: 5 * time.Second}, auth.NewUserCode, now)
		return err
	})
	return out, err
}

func poll(t *testing.T, s *pdb.Store, code string, now time.Time) auth.PollOutcome {
	t.Helper()
	var res auth.PollResult
	if err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		res, err = auth.PollDeviceCode(ctx, d, nil, code, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return res.Outcome
}

func TestDenialIsToldOnceEvenWhenThePollSharesItsMillisecond(t *testing.T) {
	s := migratedStore(t)
	var owner identity.Human
	if err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		owner, err = identity.CreateOwner(ctx, d, "drew", "Drew", flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	code, err := request(t, s, "10.0.0.1", flowNow)
	if err != nil {
		t.Fatal(err)
	}
	if got := poll(t, s, code.DeviceCode, flowNow); got != auth.PollPending {
		t.Fatalf("first poll: %v", got)
	}
	if err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := auth.DenyAllRequests(ctx, d, owner.ID, flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got := poll(t, s, code.DeviceCode, flowNow); got != auth.PollDenied {
		t.Fatalf("the poll in the denial's millisecond has not heard it yet: %v", got)
	}
	if got := poll(t, s, code.DeviceCode, flowNow.Add(10*time.Second)); got != auth.PollExpired {
		t.Fatalf("a denial is told once: %v", got)
	}
}

func TestPendingCapsPerSourceAndOverall(t *testing.T) {
	s := migratedStore(t)
	for i := 0; i < auth.MaxPendingRequests; i++ {
		if _, err := request(t, s, "10.0.0.1", flowNow); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := request(t, s, "10.0.0.1", flowNow); !errors.Is(err, auth.ErrTooManyPending) {
		t.Fatalf("a fourth from one source: %v", err)
	}
	if _, err := request(t, s, "10.0.0.2", flowNow); err != nil {
		t.Fatalf("another source is not blocked: %v", err)
	}
	for i := 0; i < auth.MaxPendingAll-auth.MaxPendingRequests-1; i++ {
		if _, err := request(t, s, fmt.Sprintf("10.1.0.%d", i), flowNow); err != nil {
			t.Fatalf("source %d: %v", i, err)
		}
	}
	if _, err := request(t, s, "10.2.0.1", flowNow); !errors.Is(err, auth.ErrPendingFull) {
		t.Fatalf("past the overall cap: %v", err)
	}
}

func TestDeviceCodeLiveReadsOnlyForKnownCodes(t *testing.T) {
	s := migratedStore(t)
	code, err := request(t, s, "10.0.0.1", flowNow)
	if err != nil {
		t.Fatal(err)
	}
	live := func(c string, now time.Time) bool {
		ok, err := auth.DeviceCodeLive(context.Background(), s.Reader.SQL(), c, now)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !live(code.DeviceCode, flowNow) {
		t.Error("a pending code is live")
	}
	if live("cvz_c_TESTONLYnothing", flowNow) {
		t.Error("an unknown code is not live")
	}
	if live(code.DeviceCode, flowNow.Add(auth.RequestTTL+time.Second)) {
		t.Error("an expired code is not live")
	}
}

// machineWithKey makes an owner-approved machine and returns its key.
func machineWithKey(t *testing.T, s *pdb.Store, owner identity.Human, name string, scopes int64) string {
	t.Helper()
	box, err := auth.NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	var key string
	if err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		id, err := auth.CreateMachine(ctx, d, box, auth.NewMachine{Name: name, Scopes: scopes, Allow: auth.Allow{Mode: auth.AllowAny}, ApprovedBy: owner.ID}, flowNow)
		if err != nil {
			return err
		}
		key, err = auth.RevealKey(ctx, d, box, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return key
}

func mint(t *testing.T, s *pdb.Store, in auth.MintRequest) (auth.MintedSession, error) {
	t.Helper()
	var out auth.MintedSession
	err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		out, err = auth.MintSession(ctx, d, flowPorts, in, flowNow)
		return err
	})
	return out, err
}

func TestMintSessionRules(t *testing.T) {
	s := migratedStore(t)
	var owner identity.Human
	if err := inTx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		owner, err = identity.CreateOwner(ctx, d, "drew", "Drew", flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	plain := machineWithKey(t, s, owner, "box-1", auth.DefaultScopes)
	maker := machineWithKey(t, s, owner, "box-2", auth.DefaultScopes|auth.ScopeCreateIdentity)

	var forbidden auth.ForbiddenError
	create := &auth.CreateIdentity{DisplayName: "Alpha"}
	if _, err := mint(t, s, auth.MintRequest{MachineKey: plain, As: "alpha", ClientID: "client-001", Create: create}); !errors.As(err, &forbidden) {
		t.Errorf("create without the scope: %v", err)
	}
	if _, err := mint(t, s, auth.MintRequest{MachineKey: maker, As: "drew", ClientID: "client-001"}); !errors.As(err, &forbidden) {
		t.Errorf("a human cannot start a session: %v", err)
	}
	if _, err := mint(t, s, auth.MintRequest{MachineKey: "cvz_m_TESTONLYnone", As: "alpha", ClientID: "client-001"}); !errors.Is(err, auth.ErrMachineGone) {
		t.Errorf("an unknown key: %v", err)
	}

	names := []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"}
	for i, n := range names[:auth.CreatedPerDay] {
		got, err := mint(t, s, auth.MintRequest{MachineKey: maker, As: strings.ToLower(n), ClientID: fmt.Sprintf("client-%03d", i), Create: &auth.CreateIdentity{DisplayName: n}})
		if err != nil || got.Handle != strings.ToLower(n) {
			t.Fatalf("create %s: %+v %v", n, got, err)
		}
	}
	var limited *auth.RateLimitedError
	_, err := mint(t, s, auth.MintRequest{MachineKey: maker, As: "foxtrot", ClientID: "client-099", Create: &auth.CreateIdentity{DisplayName: "Foxtrot"}})
	if !errors.As(err, &limited) || limited.RetryAfter < time.Second {
		t.Fatalf("a sixth identity in a day: %v", err)
	}
}

func TestClipKeepsPrintableASCIIOnly(t *testing.T) {
	got := clip("a‮b\x00c\tdé" + strings.Repeat("x", 40))
	if want := "abcd" + strings.Repeat("x", hostInfoLimit-4); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
