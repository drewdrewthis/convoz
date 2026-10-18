package httpapi

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const testAgentHost = "dot.testonly.ts.net"

func agentTestAPI(t *testing.T) *Server {
	t.Helper()
	cfg := Config{Host: "convoz.testonly.ts.net", Version: "test", AgentHost: testAgentHost, AgentPort: 45123, AgentOrigin: "https://" + testAgentHost}
	return NewServer(dbtest.Store(t), platform.NewClock(), nil, nil, cfg, log.New(io.Discard, "", 0))
}

func agentTestServer(t *testing.T) http.Handler { return agentTestAPI(t).AgentHandler() }

// viaFunnel is a request as the local Funnel proxy forwards it: from loopback, with the marker and the client in X-Forwarded-For.
func viaFunnel(method, path, client, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host, req.RemoteAddr = testAgentHost, "127.0.0.1:4000"
	req.Header.Set(funnelMarker, "?1")
	req.Header.Set("X-Forwarded-For", client)
	return req
}

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// sample turns a pattern such as /api/files/:public_id into a path a request can carry.
func sample(pattern string) string {
	parts := strings.Split(pattern, "/")
	for i, p := range parts {
		if strings.HasPrefix(p, ":") {
			parts[i] = "x1"
		}
	}
	return strings.Join(parts, "/")
}

// notAServedRoute is the catch-all's answer: the same bytes as an unknown path.
func notAServedRoute(rec *httptest.ResponseRecorder) bool {
	return rec.Code == http.StatusNotFound && strings.Contains(rec.Body.String(), "No such route.")
}

// The agent listener must serve a route only when the table says so with a reason; a new route is refused until someone
// gives it one. This walks the whole table through the real handler.
func TestEveryRouteIsServedOnTheAgentListenerWithAReasonOrRefused(t *testing.T) {
	h := agentTestServer(t)
	served := map[string]string{}
	for n, rt := range Routes {
		reason, ok := rt.AgentReason()
		req := viaFunnel(rt.Method, sample(rt.Pattern), "198.51.100."+strconv.Itoa(n%250+1), "") // a fresh client each: the failed-auth limit is per client
		req.Header.Set("Cookie", DeviceCookie+"=TESTONLY-owner-cookie")                          // an owner cookie buys nothing here
		rec := serve(h, req)
		id := rt.Method + " " + rt.Pattern
		switch {
		case ok && reason == "":
			t.Errorf("%s: served with no reason", id)
		case ok && notAServedRoute(rec):
			t.Errorf("%s: the table serves it (%s) but the listener answered 404", id, reason)
		case !ok && !notAServedRoute(rec):
			t.Errorf("%s: refused by the table but the listener answered %d", id, rec.Code)
		}
		if ok {
			served[id] = reason
			if (rt.Auth == authz.Owner && !rt.Lease) || rt.RefuseLease || (rt.Agent != "" && rt.Auth != authz.Pub) {
				t.Errorf("%s: an owner or browser route must never be served on the agent listener", id)
			}
		}
	}
	// The no-credential routes are pinned by name: widening this list is a decision, made here, with a reviewer.
	pub := []string{"GET /healthz", "GET /api/version", "GET /install", "GET /cli/:file", "POST /api/device/code", "POST /api/device/token"}
	for id, reason := range served {
		if reason != "session lease" && reason != "machine key" && !contains(pub, id) {
			t.Errorf("%s (%s): a route with no credential is not in the pinned list", id, reason)
		}
	}
	for _, id := range pub {
		if served[id] == "" {
			t.Errorf("%s: pinned but not served", id)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestAgentListenerRefusesAForeignHost(t *testing.T) {
	h := agentTestServer(t)
	for host, want := range map[string]int{
		testAgentHost:                http.StatusOK,
		testAgentHost + ".":          http.StatusOK, // a fully qualified name ends in a dot
		testAgentHost + ".:443":      http.StatusOK,
		testAgentHost + ":443":       http.StatusOK,
		testAgentHost + ":45123":     http.StatusOK,
		"convoz.testonly.ts.net":     http.StatusMisdirectedRequest,
		testAgentHost + ".evil.test": http.StatusMisdirectedRequest,
		"":                           http.StatusMisdirectedRequest,
	} {
		req := viaFunnel("GET", "/healthz", "203.0.113.9", "")
		req.Host = host
		if got := serve(h, req).Code; got != want {
			t.Errorf("Host %q: got %d want %d", host, got, want)
		}
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name, peer, marker, xff, want string
		ok                            bool
	}{
		{"funnel proxy", "127.0.0.1:5555", "?1", "203.0.113.9", "203.0.113.9", true},
		{"last entry is the proxy's", "127.0.0.1:5555", "?1", "198.51.100.1, 203.0.113.9", "203.0.113.9", true},
		{"ipv6 client", "[::1]:5555", "?1", "2001:db8::1", "2001:db8::1", true},
		{"mapped address is the ipv4 address", "127.0.0.1:5555", "?1", "::ffff:203.0.113.9", "203.0.113.9", true},
		{"zone is dropped", "127.0.0.1:5555", "?1", "fe80::1%junk", "fe80::1", true},
		{"mapped loopback peer is loopback", "[::ffff:127.0.0.1]:5555", "?1", "203.0.113.9", "203.0.113.9", true},
		{"no marker: not Funnel", "127.0.0.1:5555", "", "203.0.113.9", "", false},
		{"no marker, no header", "127.0.0.1:5555", "", "", "", false},
		{"marker, no header", "127.0.0.1:5555", "?1", "", "", false},
		{"marker, junk header", "127.0.0.1:5555", "?1", "not-an-ip", "", false},
		{"not the proxy: the peer itself", "192.0.2.7:5555", "", "203.0.113.9", "192.0.2.7", true},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.peer
		if c.marker != "" {
			r.Header.Set(funnelMarker, c.marker)
		}
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		got, ok := clientIP(r)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got %q %v want %q %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestLimitKeyCountsAnIPv6SubscriberOnce(t *testing.T) {
	a, b := limitKey("2001:db8:1:2:aaaa::1"), limitKey("2001:db8:1:2:bbbb::9")
	if a != b || a != "2001:db8:1:2::/64" {
		t.Fatalf("got %q and %q", a, b)
	}
	if limitKey("2001:db8:1:3::1") == a {
		t.Fatal("another /64 shares a bucket")
	}
	if limitKey("203.0.113.9") != "203.0.113.9" {
		t.Fatal("an ipv4 address is its own key")
	}
}

func TestAgentListenerAnswers400WhenTheClientCannotBeTold(t *testing.T) {
	h := agentTestServer(t)
	noMarker := httptest.NewRequest("GET", "/healthz", nil)
	noMarker.Host, noMarker.RemoteAddr = testAgentHost, "127.0.0.1:4000"
	forged := httptest.NewRequest("GET", "/healthz", nil)
	forged.Host, forged.RemoteAddr = testAgentHost, "127.0.0.1:4000"
	forged.Header.Set("X-Forwarded-For", "203.0.113.9") // anyone on the box can write this
	for name, req := range map[string]*http.Request{"no header": noMarker, "forged header without the Funnel marker": forged} {
		if got := serve(h, req).Code; got != http.StatusBadRequest {
			t.Errorf("%s: got %d want 400", name, got)
		}
	}
	if got := serve(h, viaFunnel("GET", "/healthz", "203.0.113.9", "")).Code; got != http.StatusOK {
		t.Errorf("a Funnel request: got %d", got)
	}
}

func TestOneClientsFailuresDoNotLockOutAnother(t *testing.T) {
	h := agentTestServer(t)
	bad := func(ip string) int {
		req := viaFunnel("GET", "/api/me", ip, "")
		req.Header.Set("Authorization", "Bearer cvz_s_TESTONLYnotalease")
		return serve(h, req).Code
	}
	for i := 0; i < agentFailsPer10Min; i++ {
		if got := bad("203.0.113.30"); got != http.StatusUnauthorized {
			t.Fatalf("try %d: got %d want 401", i+1, got)
		}
	}
	if got := bad("203.0.113.30"); got != http.StatusTooManyRequests {
		t.Fatalf("31st try: got %d want 429", got)
	}
	if got := bad("203.0.113.31"); got != http.StatusUnauthorized {
		t.Fatalf("another client: got %d want 401", got)
	}
}

func startDevice(h http.Handler, ip, body string) *httptest.ResponseRecorder {
	return serve(h, viaFunnel("POST", "/api/device/code", ip, body))
}

func deviceBody(name, handle string) string {
	id := ""
	if handle != "" {
		id = `,"identity":{"handle":"` + handle + `"}`
	}
	return `{"name":"` + name + `","host_info":{"hostname":"h","os":"linux","arch":"amd64","cli_version":"x"}` + id + `}`
}

func TestAgentListenerLimitsLoginStartsPerClient(t *testing.T) {
	h := agentTestServer(t)
	for i := 0; i < agentStartsPerHour; i++ {
		if got := startDevice(h, "203.0.113.9", `{}`).Code; got != http.StatusBadRequest { // an invalid name: counted, never stored
			t.Fatalf("start %d: got %d want 400", i+1, got)
		}
	}
	if got := startDevice(h, "203.0.113.9", `{}`).Code; got != http.StatusTooManyRequests {
		t.Fatalf("11th start: got %d want 429", got)
	}
	if got := startDevice(h, "203.0.113.10", `{}`).Code; got != http.StatusBadRequest {
		t.Fatalf("another client: got %d want 400", got)
	}
}

func TestAgentListenerCapsLoginStartsOfEveryoneTogether(t *testing.T) {
	h := agentTestServer(t)
	for i := 0; i < agentStartsAllPerHour; i++ {
		if got := startDevice(h, fmt.Sprintf("198.51.100.%d", i+1), `{}`).Code; got != http.StatusBadRequest {
			t.Fatalf("start %d: got %d want 400", i+1, got)
		}
	}
	rec := startDevice(h, "198.51.100.200", `{}`)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("21st start from a new client: got %d %v", rec.Code, rec.Header())
	}
}

func TestAgentListenerLimitsStartsOfOneIPv6Subscriber(t *testing.T) {
	h := agentTestServer(t)
	for i := 0; i < agentStartsPerHour; i++ {
		startDevice(h, fmt.Sprintf("2001:db8:1:2::%x", i+1), `{}`) // ten addresses of one /64
	}
	if got := startDevice(h, "2001:db8:1:2:ffff::1", `{}`).Code; got != http.StatusTooManyRequests {
		t.Fatalf("11th address of the same /64: got %d want 429", got)
	}
}

func TestAgentListenerRefusesADuplicatePendingNameOrHandle(t *testing.T) {
	h := agentTestServer(t)
	if got := startDevice(h, "203.0.113.1", deviceBody("box-1", "dot")).Code; got != http.StatusOK {
		t.Fatalf("first request: got %d", got)
	}
	for name, body := range map[string]string{"same machine name": deviceBody("box-1", "other"), "same handle": deviceBody("box-2", "dot")} {
		rec := startDevice(h, "203.0.113.2", body)
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "duplicate_pending") {
			t.Errorf("%s: got %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if got := startDevice(h, "203.0.113.3", deviceBody("box-3", "cat")).Code; got != http.StatusOK {
		t.Errorf("a different name and handle: got %d", got)
	}
}

func TestAgentListenerLimitsDownloadsPerClient(t *testing.T) {
	h := agentTestServer(t)
	for i := 0; i < agentDownloadsPerHour; i++ {
		if got := serve(h, viaFunnel("GET", "/install", "203.0.113.50", "")).Code; got != http.StatusOK {
			t.Fatalf("download %d: got %d", i+1, got)
		}
	}
	if got := serve(h, viaFunnel("GET", "/cli/SHA256SUMS", "203.0.113.50", "")).Code; got != http.StatusTooManyRequests {
		t.Fatalf("31st download: got %d want 429", got)
	}
	if got := serve(h, viaFunnel("GET", "/install", "203.0.113.51", "")).Code; got != http.StatusOK {
		t.Fatalf("another client: got %d", got)
	}
}

func TestAgentVersionIsAShortCommit(t *testing.T) {
	s := agentTestAPI(t)
	s.Cfg.Version = "fbab9b4ae66b+dirty"
	body := serve(s.AgentHandler(), viaFunnel("GET", "/api/version", "203.0.113.9", "")).Body.String()
	if !strings.Contains(body, `"version":"fbab9b4"`) {
		t.Fatalf("got %s", body)
	}
}

func TestInflightCapPerClient(t *testing.T) {
	s := agentTestAPI(t)
	release := make(chan struct{})
	var started sync.WaitGroup
	h := s.agentLimits(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started.Done()
		<-release
	}))
	req := func(ip string) *http.Request {
		return httptest.NewRequest("GET", "/api/inbox", nil).WithContext(context.WithValue(context.Background(), agentIPKey{}, ip))
	}
	var done sync.WaitGroup
	started.Add(agentInflightPerIP)
	for i := 0; i < agentInflightPerIP; i++ {
		done.Add(1)
		go func() { defer done.Done(); serve(h, req("203.0.113.9")) }()
	}
	started.Wait()
	if got := serve(h, req("203.0.113.9")).Code; got != http.StatusTooManyRequests {
		t.Errorf("21st at once: got %d want 429", got)
	}
	started.Add(1)
	go func() { defer done.Done(); serve(h, req("203.0.113.10")) }()
	done.Add(1)
	started.Wait() // another client is served while the first is full
	close(release)
	done.Wait()
}

// A body that trickles in is cut at the read timeout; a request with no body, or a read body, may run on (a long poll).
func TestReadTimeoutCutsASlowBodyAndSparesALongPoll(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /slow", func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "cut", http.StatusRequestTimeout)
		}
	})
	mux.HandleFunc("GET /poll", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2500 * time.Millisecond) // longer than the 1 s timeout below
		_, _ = w.Write([]byte("late"))
	})
	mux.HandleFunc("POST /read-then-wait", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		time.Sleep(2500 * time.Millisecond)
		_, _ = w.Write([]byte("late"))
	})
	srv := httptest.NewUnstartedServer(clearReadDeadline(mux))
	srv.Config.ReadTimeout = time.Second
	srv.Start()
	defer srv.Close()

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	start := time.Now()
	_, _ = conn.Write([]byte("POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab")) // 2 of 100 bytes, then silence
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.ReadAll(conn)
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("the slow body was closed after %v, want within the 1 s timeout (plus slack)", d)
	}

	for _, c := range []struct{ method, path, body string }{{"GET", "/poll", ""}, {"POST", "/read-then-wait", "{}"}} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader(c.body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(b) != "late" {
			t.Errorf("%s %s: the long request was cut: %q", c.method, c.path, b)
		}
	}
}

func TestLimitConnsHoldsASlotUntilTheConnectionCloses(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lim := LimitConns(ln, 1)
	defer lim.Close()
	accepted := make(chan net.Conn, 2)
	go func() {
		for {
			c, err := lim.Accept()
			if err != nil {
				return
			}
			accepted <- c
		}
	}()
	dial := func() net.Conn {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	c1, c2 := dial(), dial()
	defer c1.Close()
	defer c2.Close()
	first := <-accepted
	select {
	case <-accepted:
		t.Fatal("a second connection was accepted over the cap")
	case <-time.After(300 * time.Millisecond):
	}
	first.Close()
	select {
	case <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("the slot was not freed")
	}
}
