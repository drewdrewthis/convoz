package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const (
	agentID = 50
	convID  = 60
)

// releaseRig is a server with an owner, an agent that a machine may act as, and one conversation.
type releaseRig struct {
	s         *Server
	boot      auth.BootstrapResult
	dev       auth.Device
	machineID int64
	key       string
}

func newReleaseRig(t *testing.T) *releaseRig {
	t.Helper()
	store := dbtest.Store(t)
	now := platform.SystemClock{}.Now()
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(t, store, now), "one", now)
	if err != nil {
		t.Fatal(err)
	}
	dev, ok, err := auth.LookupDevice(context.Background(), store.Reader.SQL(), boot.DeviceToken, now)
	if err != nil || !ok {
		t.Fatalf("device: %v %v", ok, err)
	}
	box, err := auth.NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	r := &releaseRig{s: NewServer(store, platform.SystemClock{}, nil, box, Config{}, log.New(io.Discard, "", 0)), boot: boot, dev: dev}
	dbtest.Exec(t, store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (50,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (50,`+strconv.FormatInt(boot.Owner.ID, 10)+`)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (60,`+strconv.FormatInt(boot.Owner.ID, 10)+`,1,1)`)
	dbtest.Tx(t, store, func(ctx context.Context, d pdb.DBTX) error {
		r.machineID, err = auth.CreateMachine(ctx, d, box, auth.NewMachine{Name: "box-1", Scopes: auth.DefaultScopes, Allow: auth.Allow{Mode: auth.AllowAny}, ApprovedBy: boot.Owner.ID}, now)
		if err != nil {
			return err
		}
		r.key, err = auth.RevealKey(ctx, d, box, r.machineID)
		return err
	})
	return r
}

// mint calls POST /api/sessions through the handler and returns the new lease's session id.
func (r *releaseRig) mint(t *testing.T) int64 {
	t.Helper()
	body, _ := json.Marshal(wire.MintRequest{As: "devtool", ClientID: "client-0001"})
	req := httptest.NewRequest("POST", "/api/sessions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	r.s.mintSession(w, req, &call{token: r.key})
	var out wire.MintResponse
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatalf("mint: %d %s", w.Code, w.Body.String())
	}
	return out.Session.ID
}

// claim gives the session a claimed inbox item on the conversation.
func (r *releaseRig) claim(t *testing.T, session int64) {
	t.Helper()
	now := platform.SystemClock{}.Now()
	dbtest.Tx(t, r.s.Store, func(ctx context.Context, d pdb.DBTX) error {
		if err := inbox.FanOut(ctx, d, now, agentID, convID, 1, 1, 0, inbox.ReasonActivity); err != nil {
			return err
		}
		items, err := inbox.Claim(ctx, d, now, inbox.Request{Identity: agentID, Session: session, N: 1})
		if err == nil && len(items) != 1 {
			t.Fatalf("claimed %d items, want 1", len(items))
		}
		return err
	})
}

// claimFreed reports whether no claim on the conversation runs any longer (a freed item is ready again, with no claim end).
func (r *releaseRig) claimFreed(t *testing.T) bool {
	t.Helper()
	var until sql.NullInt64
	if err := r.s.Store.Reader.SQL().QueryRow(`SELECT claim_until FROM inbox_items WHERE identity_id = ?`, agentID).Scan(&until); err != nil {
		t.Fatal(err)
	}
	return !until.Valid || until.Int64 < time.Now().UnixMilli()
}

// claimHolder is the session that holds the claim on the conversation; 0 when nobody does.
func (r *releaseRig) claimHolder(t *testing.T) int64 {
	t.Helper()
	var holder sql.NullInt64
	if err := r.s.Store.Reader.SQL().QueryRow(`SELECT claim_session_id FROM inbox_items WHERE identity_id = ?`, agentID).Scan(&holder); err != nil {
		t.Fatal(err)
	}
	return holder.Int64
}

// workingStopped reads the live frames and reports whether one says the agent stopped working on the conversation.
func workingStopped(sub *platform.Subscription) bool {
	for {
		select {
		case f := <-sub.C:
			if f.Event == "agent.working" && f.Conversation == convID && strings.Contains(string(f.Data), `"working":false`) {
				return true
			}
		default:
			return false
		}
	}
}

func TestAReMintOfTheSameClientMovesTheOldLeasesClaimsToTheNewLeaseAndKeepsItWorking(t *testing.T) {
	r := newReleaseRig(t)
	old := r.mint(t)
	r.claim(t, old)
	sub := r.s.Bus.Subscribe()
	defer sub.Cancel()

	again := r.mint(t)
	if again == old {
		t.Fatal("a re-mint made no new lease")
	}
	if r.claimFreed(t) || r.claimHolder(t) != again {
		t.Errorf("the new lease should hold the claim, held by session %d", r.claimHolder(t))
	}
	if workingStopped(sub) {
		t.Error("the agent is still on the work: no working=false frame")
	}
}

func TestRevokingAMachineThroughTheHandlerFreesTheClaimsOfItsLeases(t *testing.T) {
	r := newReleaseRig(t)
	r.claim(t, r.mint(t))
	now := platform.SystemClock{}.Now().UnixMilli()
	const stepUp = 1
	dbtest.Exec(t, r.s.Store, fmt.Sprintf(
		`INSERT INTO step_ups (id, device_id, passkey_id, action, target_id, created_at, expires_at) VALUES (%d, %d, 1, 'machine.revoke', %d, %d, %d)`,
		stepUp, r.dev.ID, r.machineID, now, now+60_000))
	sub := r.s.Bus.Subscribe()
	defer sub.Cancel()

	req := httptest.NewRequest("POST", "/api/machines/x/revoke", strings.NewReader("{}"))
	req.SetPathValue("id", strconv.FormatInt(r.machineID, 10))
	w := httptest.NewRecorder()
	r.s.revokeMachine(w, req, &call{human: r.boot.Owner, dev: r.dev, stepUp: stepUp})

	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	if !r.claimFreed(t) {
		t.Error("the revoked machine's lease still holds its claim")
	}
	if !workingStopped(sub) {
		t.Error("no working=false frame after the revoke")
	}
}
