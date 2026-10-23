package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// fakeInbox is a server with two ready items, in order: item 1 by an agent (the long one) and item 2 by the owner. It records
// whether anyone claimed with held=0 (only the owner lane does) and ends the session once both items are acked.
type fakeInbox struct {
	mu      sync.Mutex
	ready   []wire.InboxItem
	held    []wire.InboxItem
	acked   int
	extra   int // claims with held=0
	allDone bool
}

func newFakeInbox() *fakeInbox {
	mk := func(id int64, kind string) wire.InboxItem {
		return wire.InboxItem{ID: id, ClaimToken: "00112233445566778899aabbccddeeff", Message: wire.Message{ID: id, Author: wire.Person{Kind: kind}}}
	}
	return &fakeInbox{ready: []wire.InboxItem{mk(1, "agent"), mk(2, "human")}}
}

func (f *fakeInbox) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case wire.RouteMe:
		var me wire.MeResponse
		me.Identity.Handle = "devtool"
		_ = json.NewEncoder(w).Encode(me)
	case wire.RouteInboxAck:
		var in wire.AckRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		for _, ref := range in.Items {
			f.drop(ref.ID)
			f.acked++
		}
		_ = json.NewEncoder(w).Encode(wire.AckResponse{})
	case wire.RouteInbox:
		q := r.URL.Query()
		if q.Get("peek") == "1" {
			_ = json.NewEncoder(w).Encode(wire.InboxResponse{})
			return
		}
		if f.acked >= 2 {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(wire.Error{Error: wire.ErrorDetail{Code: wire.CodeSessionEnded, Message: "The session ended."}})
			return
		}
		var out []wire.InboxItem
		if q.Get("held") == "0" {
			f.extra++
		} else {
			out = append(out, f.held...)
		}
		limit, _ := strconv.Atoi(q.Get("claim"))
		for len(out) < limit && len(f.ready) > 0 {
			f.held = append(f.held, f.ready[0])
			out = append(out, f.ready[0])
			f.ready = f.ready[1:]
		}
		if len(out) > limit {
			out = out[:limit]
		}
		_ = json.NewEncoder(w).Encode(wire.InboxResponse{Items: out})
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeInbox) drop(id int64) {
	for i, it := range f.held {
		if it.ID == id {
			f.held = append(f.held[:i], f.held[i+1:]...)
			return
		}
	}
}

// runAgainstFake runs the real `convoz run` with a shell command that logs to a file, against the fake inbox, and returns the log lines.
// The script gets CONVOZ_ITEM; "log" is the file it appends to.
func runAgainstFake(t *testing.T, fake *fakeInbox, flags []string, script string) (lines []string, code int) {
	t.Helper()
	oldBeat, oldEvery := runHeartbeat, laneEvery
	runHeartbeat, laneEvery = time.Hour, 30*time.Millisecond
	t.Cleanup(func() { runHeartbeat, laneEvery = oldBeat, oldEvery })
	srv := httptest.NewServer(fake)
	defer srv.Close()

	xdg := t.TempDir()
	dir := filepath.Join(xdg, "convoz")
	if err := saveCredentials(dir, brokenKeychain{}, Credentials{Server: srv.URL, Machine: "box-2", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	if _, err := saveSession(dir, sessionFile{Lease: "cvz_s_TESTONLYlease", Identity: "devtool", As: "devtool", Machine: "box-2", ClientID: "convoz-run-devtool"}); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	env := func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}
	args := append([]string{"--as", "devtool", "--workdir", work}, flags...)
	args = append(args, "--", "sh", "-c", script)
	var stdout, stderr lockedBuf
	done := make(chan int, 1)
	go func() {
		done <- Run(args, IO{Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr, Getenv: env})
	}()
	select {
	case code = <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("run did not end; stderr: %s", stderr.String())
	}
	raw, _ := os.ReadFile(filepath.Join(work, "log"))
	return strings.Fields(string(raw)), code
}

// lockedBuf is a buffer two child processes can write to at once, as the main call and the extra call do.
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// Item 1 runs 1.5 s. With the lane on, the owner item 2 starts in that time; with it off, it starts only after item 1 ended.
const orderScript = `echo start$CONVOZ_ITEM >> log; [ "$CONVOZ_ITEM" = 1 ] && sleep 1.5; echo end$CONVOZ_ITEM >> log`

func TestRunWithOwnerLaneStartsTheOwnerItemBesideTheLongItem(t *testing.T) {
	fake := newFakeInbox()
	lines, code := runAgainstFake(t, fake, nil, orderScript)
	if code != ExitAuth {
		t.Fatalf("exit %d, want 3 when the session ends", code)
	}
	if got := strings.Join(lines, ","); got != "start1,start2,end2,end1" {
		t.Errorf("order %s, want the owner item to run beside the long one", got)
	}
}

func TestRunWithOwnerLaneOffQueuesTheOwnerItemBehindTheLongItem(t *testing.T) {
	fake := newFakeInbox()
	lines, code := runAgainstFake(t, fake, []string{"--owner-lane=false"}, orderScript)
	if code != ExitAuth {
		t.Fatalf("exit %d, want 3 when the session ends", code)
	}
	if got := strings.Join(lines, ","); got != "start1,end1,start2,end2" {
		t.Errorf("order %s, want the owner item to wait for the long one", got)
	}
	if fake.extra != 0 {
		t.Errorf("the lane claimed %d times with the flag off", fake.extra)
	}
}

// The extra call is killed at its own timeout while the main item keeps running: item 2 would sleep 30 s, item 1 ends on its own
// after 2 s. The retry of item 2 (the main loop gets it after the failure) returns at once.
func TestOwnerLaneCallIsKilledAtItsOwnTimeoutAndTheMainItemKeepsRunning(t *testing.T) {
	script := `case "$CONVOZ_ITEM" in
1) echo start1 >> log; sleep 2; echo end1 >> log;;
2) if [ -e seen2 ]; then echo retry2 >> log; else touch seen2; echo start2 >> log; sleep 30; echo end2 >> log; fi;;
esac`
	began := time.Now()
	lines, code := runAgainstFake(t, newFakeInbox(), []string{"--owner-lane-timeout", "300ms", "--item-timeout", "20s"}, script)
	if code != ExitAuth {
		t.Fatalf("exit %d, want 3 when the session ends", code)
	}
	if got := strings.Join(lines, ","); got != "start1,start2,end1,retry2" {
		t.Errorf("order %s: item 2 should be killed (no end2) while item 1 still ends", got)
	}
	if took := time.Since(began); took > 15*time.Second {
		t.Errorf("took %s: the extra call was not killed at its timeout", took)
	}
}
