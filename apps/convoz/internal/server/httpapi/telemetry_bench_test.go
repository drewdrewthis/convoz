package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/telemetry"
)

// benchChats is the issue 107 / PR 106 shape: 200 chats, 40 @mentioning the owner, 20 with the owner writing first, 10 with an open ask.
const benchChats = 200

// BenchmarkTelemetryOverhead times the two busiest reads over the same 200-chat seed with telemetry off (no observer, no
// Server.Telemetry) and on (Setup against a fake OTLP receiver, observer wired as serve.go does).
func BenchmarkTelemetryOverhead(b *testing.B) {
	for _, path := range []string{"/api/now", "/api/conversations"} {
		for _, mode := range []string{"off", "on"} {
			b.Run(path[len("/api/"):]+"/"+mode, func(b *testing.B) {
				h, cookie := benchServer(b, mode == "on")
				assertBenchShape(b, h, cookie)
				for i := 0; i < 5; i++ {
					benchGet(b, h, cookie, path)
				}
				lat := make([]float64, 0, b.N)
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					start := time.Now()
					benchGet(b, h, cookie, path)
					lat = append(lat, float64(time.Since(start))/float64(time.Millisecond))
				}
				b.StopTimer()
				sort.Float64s(lat)
				b.ReportMetric(lat[len(lat)*50/100], "p50-ms")
				b.ReportMetric(lat[len(lat)*95/100], "p95-ms")
			})
		}
	}
}

// benchGet serves one GET through the full handler chain as the owner and returns the body.
func benchGet(b testing.TB, h http.Handler, cookie, path string) []byte {
	b.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "localhost"
	req.Header.Set("Cookie", DeviceCookie+"="+cookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		b.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
	}
	return rec.Body.Bytes()
}

// assertBenchShape fails the bench unless the real routes show the seeded shape; an empty list would time nothing.
func assertBenchShape(b testing.TB, h http.Handler, cookie string) {
	b.Helper()
	var list struct {
		Conversations []json.RawMessage `json:"conversations"`
	}
	if err := json.Unmarshal(benchGet(b, h, cookie, "/api/conversations"), &list); err != nil {
		b.Fatal(err)
	}
	var now struct {
		Badge    int               `json:"badge"`
		Mentions int               `json:"mentions"`
		Asks     []json.RawMessage `json:"asks"`
	}
	if err := json.Unmarshal(benchGet(b, h, cookie, "/api/now"), &now); err != nil {
		b.Fatal(err)
	}
	if len(list.Conversations) != benchChats || now.Badge == 0 || now.Mentions == 0 || len(now.Asks) == 0 {
		b.Fatalf("seed shape: %d conversations (want %d), badge %d, mentions %d, asks %d; want all nonzero", len(list.Conversations), benchChats, now.Badge, now.Mentions, len(now.Asks))
	}
}

// seedBenchChats is seedTimingRun plus what makes the chats the owner's: the owner and the agent as active participants,
// an open agent ask in the first 10 chats, and the counters posting would keep.
func seedBenchChats(b testing.TB, s *pdb.Store, n int) {
	b.Helper()
	seedTimingRun(b, s, n)
	var parts, asks, askRows []string
	for i := 1; i <= n; i++ {
		parts = append(parts, fmt.Sprintf("(%d,1,'active',1,1,1)", 1000+i), fmt.Sprintf("(%d,2,'active',1,1,1)", 1000+i))
	}
	for i := 1; i <= 10; i++ {
		id := 5000 + i
		asks = append(asks, fmt.Sprintf("(%d,%d,2,'ask','Merge it?',%d)", id, 1000+i, i))
		askRows = append(askRows, fmt.Sprintf("(%d,%d,2,'Merge it?','open',1,1,1)", id, 1000+i))
	}
	dbtest.Exec(b, s,
		`INSERT INTO participants (conversation_id, identity_id, status, added_by, added_at, status_at) VALUES `+strings.Join(parts, ","),
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES `+strings.Join(asks, ","),
		`INSERT INTO asks (message_id, conversation_id, asker_id, question, state, version, created_at, updated_at) VALUES `+strings.Join(askRows, ","),
		lastMainFixup,
		// Posting keeps these counters; without message_count the empty-chat GC in maintainSoon purges every seeded chat.
		`UPDATE conversations SET message_count = (SELECT count(*) FROM messages m WHERE m.conversation_id = conversations.id),
		   last_message_id = (SELECT MAX(id) FROM messages m WHERE m.conversation_id = conversations.id),
		   open_ask_count = (SELECT count(*) FROM asks a WHERE a.conversation_id = conversations.id AND a.state = 'open')`)
}

// benchServer is the public handler over a seeded store and the owner's device cookie.
func benchServer(b testing.TB, telemetryOn bool) (http.Handler, string) {
	b.Helper()
	var opts []pdb.Option
	var tel *telemetry.Telemetry
	if telemetryOn {
		tel = startTelemetry(b, newReceiver(b))
		opts = append(opts, pdb.WithQueryObserver(tel.ObserveQuery))
	}
	key := append([]byte("TESTONLY"), make([]byte, 24)...)
	store, err := pdb.Open(filepath.Join(b.TempDir(), "t.db"), key, opts...)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = store.Close() })
	if err := platform.Migrate(context.Background(), store, platform.MigrateOptions{DataDir: b.TempDir(), Clock: platform.SystemClock{}}); err != nil {
		b.Fatal(err)
	}
	now := time.Now()
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(b, store, now), "one", now)
	if err != nil {
		b.Fatal(err)
	}
	// the seeded author 2 is an agent.
	dbtest.Exec(b, store, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (2,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`)
	seedBenchChats(b, store, benchChats)
	s := NewServer(store, platform.SystemClock{}, nil, nil, Config{Host: "localhost", Origin: "http://localhost"}, log.New(io.Discard, "", 0))
	s.Telemetry = tel
	return s.Handler(), boot.DeviceToken
}
