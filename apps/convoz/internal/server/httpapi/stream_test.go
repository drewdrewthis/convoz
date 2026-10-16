package httpapi

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// streamRig is a server with a signed-in owner, one conversation and the owner's event stream open.
type streamRig struct {
	s    *Server
	c    *call
	conv int64

	mu   sync.Mutex
	seen strings.Builder
	done chan struct{} // closed when the stream ends
}

// openRig signs in the owner; role is the role the stream treats the caller as ("owner" sees every conversation).
func openRig(t *testing.T, role string) *streamRig {
	t.Helper()
	store := migratedStore(t)
	now := platform.SystemClock{}.Now()
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(t, store, now), "one", now)
	if err != nil {
		t.Fatal(err)
	}
	dev, ok, err := auth.LookupDevice(context.Background(), store.Reader.SQL(), boot.DeviceToken, now)
	if err != nil || !ok {
		t.Fatalf("device: %v %v", ok, err)
	}
	rig := &streamRig{
		s:    NewServer(store, platform.SystemClock{}, nil, nil, Config{}, log.New(io.Discard, "", 0)),
		c:    &call{p: authz.Principal{Authenticated: true, HumanID: boot.Owner.ID, DeviceID: dev.ID, Role: role}, dev: dev, human: boot.Owner, token: boot.DeviceToken},
		done: make(chan struct{}),
	}
	rig.s.heartbeat = 50 * time.Millisecond
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: boot.Owner.ID})
		rig.conv = cv.ID
		if err != nil {
			return err
		}
		return readstate.Create(ctx, d, now, boot.Owner.ID, cv.ID, 0)
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { rig.s.stream(w, r, rig.c) }))
	t.Cleanup(srv.Close)
	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.Header.Set("Accept", "text/event-stream")
	res, err := srv.Client().Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("open stream: %v %v", res, err)
	}
	t.Cleanup(func() { _ = res.Body.Close() }) // runs before srv.Close, which waits for open streams
	go func() {
		defer close(rig.done)
		buf := make([]byte, 4096)
		for {
			n, err := res.Body.Read(buf)
			rig.mu.Lock()
			rig.seen.Write(buf[:n])
			rig.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	rig.waitSeen(t, ": open")
	return rig
}

func (r *streamRig) inTx(t *testing.T, fn func(ctx context.Context, d pdb.DBTX) error) {
	t.Helper()
	if err := inTx(t, r.s.Store, fn); err != nil {
		t.Fatal(err)
	}
}

func (r *streamRig) text() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.seen.String()
}

func (r *streamRig) waitSeen(t *testing.T, want string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if strings.Contains(r.text(), want) {
			return
		}
	}
	t.Fatalf("stream never showed %q; got %q", want, r.text())
}

// logout revokes the device the way POST /api/auth/logout does.
func (r *streamRig) revoke(t *testing.T) {
	t.Helper()
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := auth.RevokeDevice(ctx, d, r.c.human.ID, r.c.dev.ID, "logout", platform.SystemClock{}.Now())
		return err
	})
}

// ownerPosts is the owner posting "secret-body" after the revoke, and the wake a commit gives the streams.
func (r *streamRig) ownerPosts(t *testing.T, notify bool) {
	t.Helper()
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := message.Post(ctx, d, messagePorts(r.c.p), platform.SystemClock{}.Now(), message.Draft{
			Conversation: r.conv, Author: r.c.human.ID, Device: r.c.dev.ID, ClientID: "client-secret", Body: "secret-body",
		})
		return err
	})
	if notify {
		r.s.Bus.Notify()
	}
}

func (r *streamRig) mustClose(t *testing.T) {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream is still open after its session ended")
	}
	if strings.Contains(r.text(), "secret-body") {
		t.Fatalf("a message body reached a stream whose session had ended: %q", r.text())
	}
}

func TestStreamClosesOnLogoutAndGetsNoBodyAfterIt(t *testing.T) {
	rig := openRig(t, "owner")
	rig.revoke(t)
	rig.s.streams.cancelDevice(rig.c.dev.ID) // what the logout and delete-device handlers do after the commit
	rig.ownerPosts(t, true)
	rig.mustClose(t)
}

func TestStreamChecksItsDeviceOnEveryWake(t *testing.T) {
	rig := openRig(t, "owner")
	rig.s.heartbeat = time.Hour // only a commit wakes it
	rig.revoke(t)               // nothing cancels the stream: the re-check on the wake must
	rig.ownerPosts(t, true)
	rig.mustClose(t)
}

func TestStreamChecksItsDeviceOnEveryHeartbeat(t *testing.T) {
	rig := openRig(t, "owner")
	rig.revoke(t) // no commit wake and no cancel: the heartbeat finds the device gone
	rig.mustClose(t)
}

func TestWorkingFrameReachesOnlyReadersWhoSeeTheConversation(t *testing.T) {
	rig := openRig(t, "member") // not the owner, so only a conversation it takes part in is visible
	rig.s.publishWorking(context.Background(), rig.c.human.ID, rig.conv, true, 1_800_000_000_000)
	rig.waitSeen(t, "event: agent.working")
	if !strings.Contains(rig.text(), `"until":1800000000000`) || !strings.Contains(rig.text(), `"conversation_id"`) {
		t.Errorf("the frame carries the conversation and the end of the claim: %q", rig.text())
	}
	before := len(rig.text())
	rig.s.publishWorking(context.Background(), rig.c.human.ID, rig.conv+999, true, 1) // a conversation that does not exist
	time.Sleep(200 * time.Millisecond)
	if len(rig.text()) != before && strings.Contains(rig.text()[before:], "agent.working") {
		t.Errorf("a frame for a conversation the reader cannot see was written: %q", rig.text()[before:])
	}
}
