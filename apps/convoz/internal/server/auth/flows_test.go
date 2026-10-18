package auth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"strings"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

var flowNow = time.Unix(1_800_000_000, 0)

// ownerRow is the minimum a flow needs from the identity module: a human identity to approve and deny as.
// The test writes it directly so auth never imports identity.
func ownerRow(t *testing.T, s *pdb.Store) Human {
	t.Helper()
	var h Human
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		res, err := d.ExecContext(ctx, `INSERT INTO identities (kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at)
			VALUES ('human', 'drew', 'Drew', 'drew', 'D', 0, ?)`, flowNow.UnixMilli())
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		if _, err = d.ExecContext(ctx, `INSERT INTO humans (identity_id, role, created_via) VALUES (?, 'owner', 'bootstrap')`, id); err != nil {
			return err
		}
		h = Human{ID: id, Handle: "drew", DisplayName: "Drew", Role: "owner"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return h
}

// fakeAgents is an in-memory AgentPort: it keeps the agents a mint creates and counts them per machine.
type fakeAgents struct {
	byHandle map[string]Agent
	made     []int64 // machine id of each creation
}

func newFakeAgents() *fakeAgents { return &fakeAgents{byHandle: map[string]Agent{}} }

func (f *fakeAgents) ValidHandle(s string) bool { return len(s) >= 2 && len(s) <= 40 }
func (f *fakeAgents) Lookup(_ context.Context, _ pdb.DBTX, h string) (Agent, bool, error) {
	if h == "drew" {
		return Agent{ID: 1, Kind: "human", Handle: h}, true, nil
	}
	a, ok := f.byHandle[h]
	return a, ok, nil
}
func (f *fakeAgents) CheckNew(_ context.Context, _ pdb.DBTX, handle, _ string) error {
	if _, taken := f.byHandle[handle]; taken || handle == "drew" {
		return ErrHandleTaken
	}
	return nil
}
func (f *fakeAgents) SetIntro(context.Context, pdb.DBTX, int64, string, string) error { return nil }
func (f *fakeAgents) Handles(context.Context, pdb.DBTX) (map[int64]string, error)     { return nil, nil }

// Create writes the agent rows the session foreign keys need (the test owns the SQL, auth never imports identity).
func (f *fakeAgents) Create(ctx context.Context, d pdb.DBTX, in NewAgent, now time.Time) (Agent, error) {
	res, err := d.ExecContext(ctx, `INSERT INTO identities (kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at)
		VALUES ('agent', ?, ?, ?, 'A', 0, ?)`, in.Handle, in.DisplayName, in.Handle, now.UnixMilli())
	if err != nil {
		return Agent{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Agent{}, err
	}
	if _, err = d.ExecContext(ctx, `INSERT INTO agents (identity_id, created_by_machine) VALUES (?, ?)`, id, in.ByMachine); err != nil {
		return Agent{}, err
	}
	a := Agent{ID: id, Kind: "agent", Handle: in.Handle, DisplayName: in.DisplayName}
	f.byHandle[in.Handle] = a
	f.made = append(f.made, in.ByMachine)
	return a, nil
}
func (f *fakeAgents) Disable(context.Context, pdb.DBTX, int64, time.Time) (bool, error) {
	return false, nil
}
func (f *fakeAgents) CreatedByMachineSince(_ context.Context, _ pdb.DBTX, machineID int64, _ time.Time) (int64, int64, error) {
	var n int64
	for _, m := range f.made {
		if m == machineID {
			n++
		}
	}
	return n, flowNow.UnixMilli(), nil
}

type fakeJournal struct{}

func (fakeJournal) Audit(context.Context, pdb.DBTX, time.Time, AuditEntry) error { return nil }
func (fakeJournal) Event(context.Context, pdb.DBTX, time.Time, string, map[string]any) error {
	return nil
}

func request(t *testing.T, s *pdb.Store, source string, now time.Time) (DeviceCode, error) {
	t.Helper()
	var out DeviceCode
	err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		out, err = RequestDeviceCode(ctx, d, DeviceRequest{Name: "box-2", Source: source, Interval: 5 * time.Second}, NewUserCode, now)
		return err
	})
	return out, err
}

func poll(t *testing.T, s *pdb.Store, code string, now time.Time) PollOutcome {
	t.Helper()
	var res PollResult
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		res, err = PollDeviceCode(ctx, d, nil, code, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return res.Outcome
}

func TestDenialIsToldOnceEvenWhenThePollSharesItsMillisecond(t *testing.T) {
	s := dbtest.Store(t)
	owner := ownerRow(t, s)
	code, err := request(t, s, "10.0.0.1", flowNow)
	if err != nil {
		t.Fatal(err)
	}
	if got := poll(t, s, code.DeviceCode, flowNow); got != PollPending {
		t.Fatalf("first poll: %v", got)
	}
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := DenyAllRequests(ctx, d, owner.ID, flowNow)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got := poll(t, s, code.DeviceCode, flowNow); got != PollDenied {
		t.Fatalf("the poll in the denial's millisecond has not heard it yet: %v", got)
	}
	if got := poll(t, s, code.DeviceCode, flowNow.Add(10*time.Second)); got != PollExpired {
		t.Fatalf("a denial is told once: %v", got)
	}
}

func TestPendingCapsPerSourceAndOverall(t *testing.T) {
	s := dbtest.Store(t)
	for i := 0; i < MaxPendingRequests; i++ {
		if _, err := request(t, s, "10.0.0.1", flowNow); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := request(t, s, "10.0.0.1", flowNow); !errors.Is(err, ErrTooManyPending) {
		t.Fatalf("a fourth from one source: %v", err)
	}
	if _, err := request(t, s, "10.0.0.2", flowNow); err != nil {
		t.Fatalf("another source is not blocked: %v", err)
	}
	for i := 0; i < MaxPendingAll-MaxPendingRequests-1; i++ {
		if _, err := request(t, s, fmt.Sprintf("10.1.0.%d", i), flowNow); err != nil {
			t.Fatalf("source %d: %v", i, err)
		}
	}
	if _, err := request(t, s, "10.2.0.1", flowNow); !errors.Is(err, ErrPendingFull) {
		t.Fatalf("past the overall cap: %v", err)
	}
}

func TestDeviceCodeLiveReadsOnlyForKnownCodes(t *testing.T) {
	s := dbtest.Store(t)
	code, err := request(t, s, "10.0.0.1", flowNow)
	if err != nil {
		t.Fatal(err)
	}
	live := func(c string, now time.Time) bool {
		ok, err := DeviceCodeLive(context.Background(), s.Reader.SQL(), c, now)
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
	if live(code.DeviceCode, flowNow.Add(RequestTTL+time.Second)) {
		t.Error("an expired code is not live")
	}
}

// machineWithKey makes an owner-approved machine and returns its key.
func machineWithKey(t *testing.T, s *pdb.Store, owner Human, name string, scopes int64) string {
	t.Helper()
	box, err := NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	var key string
	if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		id, err := CreateMachine(ctx, d, box, NewMachine{Name: name, Scopes: scopes, Allow: Allow{Mode: AllowAny}, ApprovedBy: owner.ID}, flowNow)
		if err != nil {
			return err
		}
		key, err = RevealKey(ctx, d, box, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return key
}

func mint(t *testing.T, s *pdb.Store, ports Ports, in MintRequest) (MintedSession, error) {
	t.Helper()
	var out MintedSession
	err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		var err error
		out, err = MintSession(ctx, d, ports, in, flowNow)
		return err
	})
	return out, err
}

func TestMintSessionRules(t *testing.T) {
	s := dbtest.Store(t)
	owner := ownerRow(t, s)
	ports := Ports{Agents: newFakeAgents(), Journal: fakeJournal{}}
	plain := machineWithKey(t, s, owner, "box-1", DefaultScopes)
	maker := machineWithKey(t, s, owner, "box-2", DefaultScopes|ScopeCreateIdentity)

	var forbidden ForbiddenError
	create := &CreateIdentity{DisplayName: "Alpha"}
	// Without the scope the machine no longer gets a 403: it files a request the owner decides.
	if got, err := mint(t, s, ports, MintRequest{MachineKey: plain, As: "alpha", ClientID: "client-001", Create: create}); err != nil || got.Waiting == nil || got.Lease != "" {
		t.Errorf("create without the scope files a request: %+v %v", got, err)
	}
	if _, err := mint(t, s, ports, MintRequest{MachineKey: maker, As: "drew", ClientID: "client-001"}); !errors.As(err, &forbidden) {
		t.Errorf("a human cannot start a session: %v", err)
	}
	if _, err := mint(t, s, ports, MintRequest{MachineKey: "cvz_m_TESTONLYnone", As: "alpha", ClientID: "client-001"}); !errors.Is(err, ErrMachineGone) {
		t.Errorf("an unknown key: %v", err)
	}

	names := []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"}
	for i, n := range names[:CreatedPerDay] {
		got, err := mint(t, s, ports, MintRequest{MachineKey: maker, As: strings.ToLower(n), ClientID: fmt.Sprintf("client-%03d", i), Create: &CreateIdentity{DisplayName: n}})
		if err != nil || got.Handle != strings.ToLower(n) {
			t.Fatalf("create %s: %+v %v", n, got, err)
		}
	}
	var limited *RateLimitedError
	_, err := mint(t, s, ports, MintRequest{MachineKey: maker, As: "foxtrot", ClientID: "client-099", Create: &CreateIdentity{DisplayName: "Foxtrot"}})
	if !errors.As(err, &limited) || limited.RetryAfter < time.Second {
		t.Fatalf("a sixth identity in a day: %v", err)
	}
}
