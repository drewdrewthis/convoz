package httpapi

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// lockedLog is a log sink that a test may read while the server writes to it.
type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// accessRig is the whole owner-listener chain with a signed-in owner device, logging into a buffer.
type accessRig struct {
	h      http.Handler
	log    *lockedLog
	cookie string
	device int64
}

func newAccessRig(t *testing.T) *accessRig {
	t.Helper()
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
	sink := &lockedLog{}
	s := NewServer(store, platform.NewClock(), nil, nil, Config{Host: "localhost", Origin: "http://localhost"}, log.New(sink, "", 0))
	return &accessRig{h: s.Handler(), log: sink, cookie: boot.DeviceToken, device: dev.ID}
}

// get sends one GET through the chain with the owner's cookie (unless headers set their own) and returns the log line it wrote.
func (r *accessRig) get(t *testing.T, path string, headers map[string]string) string {
	t.Helper()
	before := r.log.String()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "localhost"
	req.Header.Set("Cookie", DeviceCookie+"="+r.cookie)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	r.h.ServeHTTP(httptest.NewRecorder(), req)
	return lastLine(t, strings.TrimPrefix(r.log.String(), before))
}

// lastLine is the last request line ("GET ...") in out; other lines (a background job's) are skipped.
func lastLine(t *testing.T, out string) string {
	t.Helper()
	lines := strings.Split(out, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "GET ") {
			return lines[i]
		}
	}
	t.Fatalf("the request wrote no log line:\n%s", out)
	return ""
}

const (
	goodTab  = "0a1b2c3d"
	goodLoad = "deadbeef"
)

func TestAccessLogOwnerLineNamesTheDeviceTabAndLoad(t *testing.T) {
	r := newAccessRig(t)
	line := r.get(t, "/api/me", map[string]string{"X-Convoz-Tab": goodTab, "X-Convoz-Load": goodLoad})
	want := regexp.MustCompile(`^GET /api/me 200 \d+ms dev=` + strconv.FormatInt(r.device, 10) + ` tab=` + goodTab + ` load=` + goodLoad + `$`)
	if !want.MatchString(line) {
		t.Fatalf("owner line %q does not match %s", line, want)
	}
}

func TestAccessLogOwnerLineWithoutIdsHasOnlyTheDevice(t *testing.T) {
	r := newAccessRig(t)
	line := r.get(t, "/api/me", nil)
	want := regexp.MustCompile(`^GET /api/me 200 \d+ms dev=` + strconv.FormatInt(r.device, 10) + `$`)
	if !want.MatchString(line) {
		t.Fatalf("owner line %q does not match %s", line, want)
	}
}

func TestAccessLogAnonymousOwnerLineHasNoDevice(t *testing.T) {
	r := newAccessRig(t)
	line := r.get(t, "/api/me", map[string]string{"Cookie": "", "X-Convoz-Tab": goodTab, "X-Convoz-Load": goodLoad})
	want := regexp.MustCompile(`^GET /api/me 401 \d+ms tab=` + goodTab + ` load=` + goodLoad + `$`)
	if !want.MatchString(line) {
		t.Fatalf("anonymous line %q does not match %s", line, want)
	}
}

// badIDs are values a tab or load id must match exactly (^[0-9a-f]{8}$) to be logged; each is distinctive enough to find if echoed.
// They are built on "cafe0123", which is neither goodTab nor goodLoad, so finding one in a line means it was echoed.
var badIDs = []string{"CAFE0123", "cafe012", "cafe01234", "zzzzzzzz", " cafe0123", "cafe0123 ", "cafe-123", "<b>TESTONLY</b>", "cvz_s_TESTONLYbad", "cafe0123,cafe0123", "x tab=00000000"}

func TestAccessLogDropsABadTabAndNeverEchoesIt(t *testing.T) {
	r := newAccessRig(t)
	for _, bad := range badIDs {
		line := r.get(t, "/api/me", map[string]string{"X-Convoz-Tab": bad, "X-Convoz-Load": goodLoad})
		if strings.Contains(line, "tab=") || strings.Contains(line, strings.TrimSpace(bad)) {
			t.Errorf("bad tab %q reached the line %q", bad, line)
		}
		if !strings.HasSuffix(line, " dev="+strconv.FormatInt(r.device, 10)+" load="+goodLoad) {
			t.Errorf("bad tab %q: the line %q lost the device or the good load", bad, line)
		}
	}
}

func TestAccessLogDropsABadLoadAndNeverEchoesIt(t *testing.T) {
	r := newAccessRig(t)
	for _, bad := range badIDs {
		line := r.get(t, "/api/me", map[string]string{"X-Convoz-Tab": goodTab, "X-Convoz-Load": bad})
		if strings.Contains(line, "load=") || strings.Contains(line, strings.TrimSpace(bad)) {
			t.Errorf("bad load %q reached the line %q", bad, line)
		}
		if !strings.HasSuffix(line, " dev="+strconv.FormatInt(r.device, 10)+" tab="+goodTab) {
			t.Errorf("bad load %q: the line %q lost the device or the good tab", bad, line)
		}
	}
}

func TestAccessLogRedactsATokenPathOnTheOwnerListener(t *testing.T) {
	r := newAccessRig(t)
	line := r.get(t, "/api/conversations/cvz_s_TESTONLYpath0000", map[string]string{"X-Convoz-Tab": goodTab, "X-Convoz-Load": goodLoad})
	if strings.Contains(line, "cvz_") || strings.Contains(line, "TESTONLYpath") {
		t.Fatalf("token path reached the line %q", line)
	}
	want := regexp.MustCompile(`^GET \[redacted\] \d{3} \d+ms dev=` + strconv.FormatInt(r.device, 10) + ` tab=` + goodTab + ` load=` + goodLoad + `$`)
	if !want.MatchString(line) {
		t.Fatalf("redacted line %q does not match %s", line, want)
	}
}

// No header value but the two checked ids may reach a line: not the cookie, not Authorization, not any other header.
func TestAccessLogHoldsNoOtherHeaderValue(t *testing.T) {
	r := newAccessRig(t)
	secrets := map[string]string{
		"Cookie":        DeviceCookie + "=" + r.cookie + "; other=TESTONLYcookieval",
		"X-Foo":         "TESTONLYfooval",
		"User-Agent":    "TESTONLYagentval",
		"Referer":       "http://localhost/TESTONLYrefval",
		"X-Convoz":      "TESTONLYxconvozval",
		"X-Convoz-Tab":  goodTab,
		"X-Convoz-Load": goodLoad,
	}
	line := r.get(t, "/api/me", secrets)
	if !strings.Contains(line, " tab="+goodTab+" load="+goodLoad) {
		t.Fatalf("the owner line %q lacks the ids, so this test proves nothing", line)
	}
	bearer := map[string]string{"Cookie": "", "Authorization": "Bearer cvz_s_TESTONLYauthval0000000000", "X-Foo": "TESTONLYfooval"}
	r.get(t, "/api/me", bearer)
	logged := r.log.String()
	for _, needle := range []string{r.cookie, "TESTONLYcookieval", "TESTONLYfooval", "TESTONLYagentval", "TESTONLYrefval", "TESTONLYxconvozval", "TESTONLYauthval", "Bearer", "cvz_"} {
		if strings.Contains(logged, needle) {
			t.Errorf("the log holds the header value %q:\n%s", needle, logged)
		}
	}
}

// The agent listener's line stays as it was: method, path, status, duration and ip=, whatever ids or cookie the request carries.
func TestAccessLogAgentLineIsUnchanged(t *testing.T) {
	sink := &lockedLog{}
	cfg := Config{Host: "convoz.testonly.ts.net", Version: "test", AgentHost: testAgentHost, AgentPort: 45123, AgentOrigin: "https://" + testAgentHost}
	h := NewServer(dbtest.Store(t), platform.NewClock(), nil, nil, cfg, log.New(sink, "", 0)).AgentHandler()
	req := viaFunnel(http.MethodGet, "/api/version", "198.51.100.7", "")
	req.Header.Set("X-Convoz-Tab", goodTab)
	req.Header.Set("X-Convoz-Load", goodLoad)
	req.Header.Set("Cookie", DeviceCookie+"=TESTONLY-owner-cookie")
	if rec := serve(h, req); rec.Code != http.StatusOK {
		t.Fatalf("GET /api/version on the agent listener: %d", rec.Code)
	}
	line := lastLine(t, sink.String())
	if want := regexp.MustCompile(`^GET /api/version 200 \d+ms ip=198\.51\.100\.7$`); !want.MatchString(line) {
		t.Fatalf("agent line %q does not match %s", line, want)
	}
}
