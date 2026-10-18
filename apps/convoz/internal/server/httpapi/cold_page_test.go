package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// coldRig is the whole public handler with a signed-in owner (cookie) and one conversation.
type coldRig struct {
	s      *Server
	h      http.Handler
	cookie string
	owner  int64
	device int64
	conv   int64
}

// laterClock is the system clock moved forward: a cookie made now is past its end by then.
type laterClock struct{ by time.Duration }

func (c laterClock) Now() time.Time { return time.Now().Add(c.by) }

func newColdRig(t *testing.T, clock platform.Clock) *coldRig {
	t.Helper()
	if cold == nil {
		t.Fatal("the web app is not built into console/web: run make -C apps/convoz web")
	}
	store := dbtest.Store(t)
	now := time.Now()
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(t, store, now), "one", now)
	if err != nil {
		t.Fatal(err)
	}
	dev, ok, err := auth.LookupDevice(context.Background(), store.Reader.SQL(), boot.DeviceToken, now)
	if err != nil || !ok {
		t.Fatalf("device: %v %v", ok, err)
	}
	s := NewServer(store, clock, nil, nil, Config{Host: "localhost", Origin: "http://localhost"}, log.New(io.Discard, "", 0))
	r := &coldRig{s: s, h: s.Handler(), cookie: boot.DeviceToken, owner: boot.Owner.ID, device: dev.ID}
	if err := dbtest.TxErr(t, store, func(ctx context.Context, d pdb.DBTX) error {
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: boot.Owner.ID})
		r.conv = cv.ID
		if err != nil {
			return err
		}
		return readstate.Create(ctx, d, now, boot.Owner.ID, cv.ID, 0)
	}); err != nil {
		t.Fatal(err)
	}
	return r
}

// do sends one request through the whole chain, as a browser on the server's origin does.
func (r *coldRig) do(method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost"
	if r.cookie != "" {
		req.Header.Set("Cookie", DeviceCookie+"="+r.cookie)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec
}

var writeHeaders = map[string]string{"Origin": "http://localhost", "X-Convoz": "1", "Content-Type": "application/json"}

// decoded is a response body as the browser reads it, whatever its Content-Encoding.
func decoded(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var rd io.Reader = bytes.NewReader(rec.Body.Bytes())
	switch rec.Header().Get("Content-Encoding") {
	case "br":
		rd = brotli.NewReader(rd)
	case "gzip":
		z, err := gzip.NewReader(rd)
		if err != nil {
			t.Fatal(err)
		}
		rd = z
	case "":
	default:
		t.Fatalf("Content-Encoding %q", rec.Header().Get("Content-Encoding"))
	}
	out, err := io.ReadAll(rd)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

var dataBlock = regexp.MustCompile(`<script type="application/json" id="` + console.DataBlockID + `">(.*?)</script>`)

// reads is the data block of a page, or nil when it has none.
func reads(t *testing.T, page string) map[string]json.RawMessage {
	t.Helper()
	m := dataBlock.FindStringSubmatch(page)
	if m == nil {
		return nil
	}
	var block struct {
		GeneratedAt int64                      `json:"generated_at"`
		Reads       map[string]json.RawMessage `json:"reads"`
	}
	if err := json.Unmarshal([]byte(m[1]), &block); err != nil {
		t.Fatalf("data block: %v", err)
	}
	if age := time.Since(time.UnixMilli(block.GeneratedAt)); age < 0 || age > 5*time.Second {
		t.Fatalf("generated_at is %v old", age)
	}
	return block.Reads
}

// The first screens carry their reads inline, made through the routes' own auth: each is what the same GET of the route answers.
func TestFirstScreensCarryTheirReadsInlineAsTheirRoutesAnswerThem(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	for page, want := range console.FirstReads() {
		rec := r.do("GET", page, map[string]string{"Accept-Encoding": "gzip, deflate, br"}, "")
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "br" {
			t.Fatalf("%s: %d, Content-Encoding %q", page, rec.Code, rec.Header().Get("Content-Encoding"))
		}
		got := reads(t, decoded(t, rec))
		if len(got) != len(want) {
			t.Fatalf("%s: inline reads %v, want %v", page, keys(got), want)
		}
		for _, path := range want {
			direct := r.do("GET", path, nil, "")
			if direct.Code != http.StatusOK {
				t.Fatalf("GET %s: %d", path, direct.Code)
			}
			if path == "/api/now" { // its answer carries the server's time, which moved on
				continue
			}
			if !jsonEqual(t, got[path], direct.Body.Bytes()) {
				t.Fatalf("%s: inline %s is %s, the route answers %s", page, path, got[path], direct.Body.Bytes())
			}
		}
		h := rec.Header()
		if h.Get("Cache-Control") != "no-store" || !slices.Contains(h.Values("Vary"), "Cookie") || strings.Contains(h.Get("Content-Security-Policy"), "unsafe-inline") {
			t.Fatalf("%s: Cache-Control %q, Vary %q, CSP %q", page, h.Get("Cache-Control"), h.Values("Vary"), h.Get("Content-Security-Policy"))
		}
	}
}

// Without a session that is still good, a first screen is never a page with data, an empty data block or a 500: it is the sign-in
// redirect every signed-in page gives.
func TestAFirstScreenWithoutALiveSessionRedirectsToSignIn(t *testing.T) {
	cases := map[string]func(t *testing.T) *coldRig{
		"logged out": func(t *testing.T) *coldRig {
			r := newColdRig(t, platform.SystemClock{})
			r.cookie = ""
			return r
		},
		"expired": func(t *testing.T) *coldRig {
			return newColdRig(t, laterClock{auth.DeviceAbsolute + time.Hour})
		},
		"revoked": func(t *testing.T) *coldRig {
			r := newColdRig(t, platform.SystemClock{})
			if err := dbtest.TxErr(t, r.s.Store, func(ctx context.Context, d pdb.DBTX) error {
				_, err := auth.RevokeDevice(ctx, d, r.owner, r.device, "user", time.Now())
				return err
			}); err != nil {
				t.Fatal(err)
			}
			return r
		},
	}
	for name, rig := range cases {
		t.Run(name, func(t *testing.T) {
			r := rig(t)
			for page := range console.FirstReads() {
				rec := r.do("GET", page, map[string]string{"Accept-Encoding": "br"}, "")
				if rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), "/signin") || dataBlock.MatchString(decoded(t, rec)) {
					t.Fatalf("%s: %d to %q", page, rec.Code, rec.Header().Get("Location"))
				}
			}
		})
	}
}

// A message or a title that would end a script element, or carries a line separator, stays inside the data block as text.
func TestTheDataBlockKeepsTextThatLooksLikeMarkup(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	body := "</script><script>alert(1)</script> <!-- & end"
	title := "</SCRIPT>\u2028line\u2029para"
	sent, _ := json.Marshal(map[string]string{"client_id": "client-markup-1", "body": body})
	if rec := r.do("POST", "/api/conversations/"+strconv.FormatInt(r.conv, 10)+"/messages", writeHeaders, string(sent)); rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("post: %d %s", rec.Code, rec.Body)
	}
	if err := dbtest.TxErr(t, r.s.Store, func(ctx context.Context, d pdb.DBTX) error {
		cv, err := conversation.Create(ctx, d, time.Now(), conversation.New{By: r.owner, Title: title})
		if err != nil {
			return err
		}
		return readstate.Create(ctx, d, time.Now(), r.owner, cv.ID, 0)
	}); err != nil {
		t.Fatal(err)
	}
	page := decoded(t, r.do("GET", "/chats", map[string]string{"Accept-Encoding": "br"}, ""))
	m := dataBlock.FindStringSubmatch(page)
	if m == nil || strings.ContainsAny(m[1], "<>&\u2028\u2029") {
		t.Fatalf("the data block holds raw markup or a line separator: %.300q", page[strings.Index(page, `id="cz-data"`):])
	}
	var list struct {
		Conversations []struct {
			Title *string `json:"title"`
			Last  *struct {
				Preview string `json:"preview"`
			} `json:"last"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(reads(t, page)["/api/conversations"], &list); err != nil || len(list.Conversations) != 2 {
		t.Fatalf("the conversation list read back: %+v %v", list, err)
	}
	var titles, previews []string
	for _, c := range list.Conversations {
		if c.Title != nil {
			titles = append(titles, *c.Title)
		}
		if c.Last != nil {
			previews = append(previews, c.Last.Preview)
		}
	}
	if !slices.Contains(titles, title) || !slices.Contains(previews, body) {
		t.Fatalf("titles %q, previews %q", titles, previews)
	}
}

// The page follows Accept-Encoding: brotli only when the client takes it, else gzip, else the plain bytes; the same page each time.
func TestTheColdPageHonoursAcceptEncoding(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	pages := map[string]string{}
	for accept, want := range map[string]string{"br": "br", "gzip, deflate": "gzip", "": "", "br;q=0, gzip": "gzip"} {
		rec := r.do("GET", "/", map[string]string{"Accept-Encoding": accept}, "")
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != want {
			t.Fatalf("Accept-Encoding %q: %d, Content-Encoding %q", accept, rec.Code, rec.Header().Get("Content-Encoding"))
		}
		pages[accept] = dataBlock.ReplaceAllString(decoded(t, rec), "")
	}
	for accept, page := range pages {
		if page != pages[""] {
			t.Fatalf("Accept-Encoding %q gave another page", accept)
		}
	}
}

// A service worker asks for the lean shell: the app's files by URL, with no user data in it to land in its cache (I-39).
func TestAServiceWorkerGetsTheLeanShell(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	for page := range console.FirstReads() {
		rec := r.do("GET", page, map[string]string{"Accept-Encoding": "br", console.LeanHeader: "lean"}, "")
		body := decoded(t, rec)
		if rec.Code != http.StatusOK || dataBlock.MatchString(body) || strings.Contains(body, "<style") || rec.Header().Get("Content-Security-Policy") != console.CSP {
			t.Fatalf("%s: %d, data block %v", page, rec.Code, dataBlock.MatchString(body))
		}
	}
}

func TestLogoutClearsSiteData(t *testing.T) {
	r := newColdRig(t, platform.SystemClock{})
	rec := r.do("POST", "/api/auth/logout", writeHeaders, "{}")
	if rec.Code != http.StatusNoContent || rec.Header().Get("Clear-Site-Data") != `"cache","cookies","storage"` {
		t.Fatalf("logout: %d, Clear-Site-Data %q", rec.Code, rec.Header().Get("Clear-Site-Data"))
	}
	if rec := r.do("GET", "/", nil, ""); rec.Code != http.StatusFound {
		t.Fatalf("the page after logout: %d", rec.Code)
	}
}

func keys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		t.Fatalf("not JSON: %s / %s", a, b)
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return bytes.Equal(ja, jb)
}
