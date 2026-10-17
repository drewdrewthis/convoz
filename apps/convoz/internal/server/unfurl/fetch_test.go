package unfurl

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// answers is a resolver that returns what it is told, one list per lookup, and counts the lookups.
type answers struct {
	mu     sync.Mutex
	script map[string][][]string
	calls  map[string]int
}

func (a *answers) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.calls == nil {
		a.calls = map[string]int{}
	}
	lists, ok := a.script[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	i := min(a.calls[host], len(lists)-1)
	a.calls[host]++
	var out []netip.Addr
	for _, s := range lists[i] {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

// world is a fetcher whose "internet" is one local server: every address it is allowed to dial is sent to the server, and the
// addresses it connected to are kept.
type world struct {
	f         *Fetcher
	dns       *answers
	mu        sync.Mutex
	connected []netip.Addr
}

func newWorld(t *testing.T, h http.Handler, script map[string][][]string) *world {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	w := &world{dns: &answers{script: script}}
	w.f = &Fetcher{resolver: w.dns, connect: func(ctx context.Context, ip netip.Addr, _ string) (net.Conn, error) {
		w.mu.Lock()
		w.connected = append(w.connected, ip)
		w.mu.Unlock()
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}}
	return w
}

const page = `<html><head><title>Plain title</title><meta property="og:title" content="Shown &amp; told"><meta name="description" content="About
 it"></head><body>x</body></html>`

func servePage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(page))
}

var publicHost = map[string][][]string{"public.test": {{"9.9.9.9"}}}

func TestFetchReadsAPublicPage(t *testing.T) {
	w := newWorld(t, http.HandlerFunc(servePage), publicHost)
	card, err := w.f.Fetch(context.Background(), "http://public.test/a#frag")
	if err != nil {
		t.Fatal(err)
	}
	if card.Title != "Shown & told" || card.Description != "About it" || card.Site != "public.test" || card.Kind != "generic" || card.URL != "http://public.test/a" {
		t.Fatalf("card = %+v", card)
	}
}

// A literal address in a link is never looked up, so it must be judged as it stands.
func TestFetchRefusesLiteralPrivateAddresses(t *testing.T) {
	var hits atomic.Int32
	w := newWorld(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	for _, target := range []string{
		"http://127.0.0.1:7788/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
		"http://[fd00:ec2::254]/", "http://100.64.0.1/", "http://0.0.0.0/", "http://[64:ff9b::a00:5]/",
	} {
		if _, err := w.f.Fetch(context.Background(), target); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", target, err)
		}
	}
	if len(w.connected) != 0 || hits.Load() != 0 {
		t.Fatalf("a refused address was dialled: %v, %d requests", w.connected, hits.Load())
	}
}

func TestFetchRefusesAHostNameThatResolvesToAPrivateAddress(t *testing.T) {
	w := newWorld(t, http.HandlerFunc(servePage), map[string][][]string{
		"inside.test": {{"10.0.0.5"}}, "mixed.test": {{"9.9.9.9", "127.0.0.1"}}, "mapped.test": {{"::ffff:10.0.0.5"}},
	})
	for _, host := range []string{"inside.test", "mixed.test", "mapped.test"} {
		if _, err := w.f.Fetch(context.Background(), "http://"+host+"/"); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", host, err)
		}
	}
	if len(w.connected) != 0 {
		t.Fatalf("dialled %v", w.connected)
	}
}

// DNS rebinding: the name answers public to the first lookup and private to the second. The worker looks up once and connects to
// the address it checked, so the second answer is never asked for, never used.
func TestFetchLooksUpOnceAndDialsTheCheckedAddress(t *testing.T) {
	w := newWorld(t, http.HandlerFunc(servePage), map[string][][]string{"rebind.test": {{"9.9.9.9"}, {"127.0.0.1"}}})
	if _, err := w.f.Fetch(context.Background(), "http://rebind.test/"); err != nil {
		t.Fatal(err)
	}
	if w.dns.calls["rebind.test"] != 1 {
		t.Fatalf("lookups = %d, want 1", w.dns.calls["rebind.test"])
	}
	if len(w.connected) != 1 || w.connected[0] != netip.MustParseAddr("9.9.9.9") {
		t.Fatalf("connected to %v, want only 9.9.9.9", w.connected)
	}
}

// The same name looked up a second time (a redirect back to it) is checked again: a name that turned private is refused then.
func TestFetchChecksAgainAfterARedirect(t *testing.T) {
	var hits atomic.Int32
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(rw, r, "http://rebind.test/second", http.StatusFound)
	}), map[string][][]string{"rebind.test": {{"9.9.9.9"}, {"127.0.0.1"}}})
	if _, err := w.f.Fetch(context.Background(), "http://rebind.test/first"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("err = %v, want ErrBlocked", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("requests = %d, want 1", hits.Load())
	}
}

func TestFetchRefusesARedirectToAPrivateAddress(t *testing.T) {
	var target atomic.Int32
	private := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { target.Add(1) }))
	defer private.Close()
	for _, to := range []string{private.URL, "http://localhost:" + strings.Split(private.Listener.Addr().String(), ":")[1] + "/", "http://169.254.169.254/", "http://[::1]/"} {
		w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { http.Redirect(rw, r, to, http.StatusMovedPermanently) }),
			map[string][][]string{"public.test": {{"9.9.9.9"}}, "localhost": {{"127.0.0.1"}}})
		if _, err := w.f.Fetch(context.Background(), "http://public.test/"); !errors.Is(err, ErrBlocked) {
			t.Errorf("redirect to %s: err = %v, want ErrBlocked", to, err)
		}
	}
	if target.Load() != 0 {
		t.Fatalf("the private listener got %d requests", target.Load())
	}
}

func TestFetchRefusesOtherSchemes(t *testing.T) {
	w := newWorld(t, http.HandlerFunc(servePage), publicHost)
	for _, raw := range []string{"ftp://public.test/", "file:///etc/passwd", "gopher://public.test/", "javascript:alert(1)", "//public.test/", "http:///nohost"} {
		if _, err := w.f.Fetch(context.Background(), raw); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", raw, err)
		}
	}
	w = newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, "ftp://public.test/x", http.StatusFound)
	}), publicHost)
	if _, err := w.f.Fetch(context.Background(), "http://public.test/"); err == nil {
		t.Fatal("a redirect to ftp: must fail")
	}
}

func TestFetchStripsCredentialsAndSendsNone(t *testing.T) {
	var auth, user string
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		auth, user = r.Header.Get("Authorization"), r.URL.User.String()
		servePage(rw, r)
	}), publicHost)
	card, err := w.f.Fetch(context.Background(), "http://name:secret@public.test/p")
	if err != nil {
		t.Fatal(err)
	}
	if auth != "" || user != "" || strings.Contains(card.URL, "secret") || strings.Contains(card.URL, "name@") {
		t.Fatalf("credentials leaked: header %q, user %q, card url %q", auth, user, card.URL)
	}
}

func TestFetchStopsAtTheBodyCap(t *testing.T) {
	var sent atomic.Int64
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/html")
		_, _ = rw.Write([]byte("<title>Big</title>"))
		chunk := []byte(strings.Repeat("a", 64<<10))
		for range 1600 { // 100 MB if the reader never stopped; the socket buffers hold a few MB of it
			n, err := rw.Write(chunk)
			sent.Add(int64(n))
			if err != nil {
				return
			}
		}
	}), publicHost)
	card, err := w.f.Fetch(context.Background(), "http://public.test/")
	if err != nil || card.Title != "Big" {
		t.Fatalf("card %+v, err %v", card, err)
	}
	if sent.Load() > 32<<20 {
		t.Fatalf("the server wrote %d bytes before the reader stopped", sent.Load())
	}
}

func TestFetchGivesUpOnASlowSite(t *testing.T) {
	release := make(chan struct{})
	w := newWorld(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }), publicHost)
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := w.f.Fetch(ctx, "http://public.test/"); err == nil || Permanent(err) {
		t.Fatalf("err = %v, want a retryable timeout", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("did not stop at the deadline")
	}
}

func TestFetchStopsAfterThreeRedirects(t *testing.T) {
	n := 0
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		n++
		http.Redirect(rw, r, fmt.Sprintf("http://public.test/%d", n), http.StatusFound)
	}), publicHost)
	if _, err := w.f.Fetch(context.Background(), "http://public.test/"); err == nil {
		t.Fatal("an endless redirect must fail")
	}
	if n > maxRedirects+1 {
		t.Fatalf("followed %d requests", n)
	}
}

func TestPermanentAndRetryableFailures(t *testing.T) {
	status := http.StatusNotFound
	ctype := "text/html"
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", ctype)
		rw.WriteHeader(status)
		_, _ = rw.Write([]byte("<title>x</title>"))
	}), map[string][][]string{"public.test": {{"9.9.9.9"}}})
	cases := []struct {
		status    int
		ctype     string
		permanent bool
	}{{404, "text/html", true}, {503, "text/html", false}, {429, "text/html", false}, {200, "image/png", true}}
	for _, c := range cases {
		status, ctype = c.status, c.ctype
		_, err := w.f.Fetch(context.Background(), "http://public.test/")
		if err == nil || Permanent(err) != c.permanent {
			t.Errorf("status %d %s: err %v, permanent %v, want %v", c.status, c.ctype, err, err != nil && Permanent(err), c.permanent)
		}
	}
	if _, err := w.f.Fetch(context.Background(), "http://nowhere.test/"); !Permanent(err) {
		t.Errorf("a name that does not exist must be permanent, got %v", err)
	}
}

func TestFetchReadsAGithubPullRequestFromTheAPI(t *testing.T) {
	var path string
	w := newWorld(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		path = r.Host + r.URL.Path
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(`{"title":"Retry budget","state":"closed","merged":true,"body":"First line\nsecond"}`))
	}), map[string][][]string{"api.github.com": {{"140.82.112.5"}}})
	w.f.plainTLS = true // the API address is https; the local server speaks plain HTTP
	card, err := w.f.Fetch(context.Background(), "http://github.com/acme/app/pull/415")
	if err != nil {
		t.Fatal(err)
	}
	if path != "api.github.com/repos/acme/app/pulls/415" {
		t.Fatalf("asked %s", path)
	}
	if card.Kind != "github_pr" || card.Title != "Retry budget" || card.Description != "First line" || card.Site != "GitHub" ||
		card.Meta["state"] != "merged" || card.Meta["repo"] != "acme/app" || card.Meta["number"] != 415 {
		t.Fatalf("card = %+v", card)
	}
}
