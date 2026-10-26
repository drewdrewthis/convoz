package httpapi

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/telemetry"
)

// BenchmarkTelemetryOverhead times the two busiest reads over the same 200-chat seed with telemetry off (no observer, no
// Server.Telemetry) and on (Setup against a fake OTLP receiver, observer wired as serve.go does).
func BenchmarkTelemetryOverhead(b *testing.B) {
	for _, path := range []string{"/api/now", "/api/conversations"} {
		for _, mode := range []string{"off", "on"} {
			b.Run(path[len("/api/"):]+"/"+mode, func(b *testing.B) {
				h, cookie := benchServer(b, mode == "on")
				lat := make([]float64, 0, b.N)
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					req := httptest.NewRequest(http.MethodGet, path, nil)
					req.Host = "localhost"
					req.Header.Set("Cookie", DeviceCookie+"="+cookie)
					rec := httptest.NewRecorder()
					start := time.Now()
					h.ServeHTTP(rec, req)
					lat = append(lat, float64(time.Since(start))/float64(time.Millisecond))
					if rec.Code != http.StatusOK {
						b.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
					}
				}
				b.StopTimer()
				sort.Float64s(lat)
				b.ReportMetric(lat[len(lat)*50/100], "p50-ms")
				b.ReportMetric(lat[len(lat)*95/100], "p95-ms")
			})
		}
	}
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
	// seedTimingRun's author 2 is an agent.
	dbtest.Exec(b, store, `INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (2,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`)
	seedTimingRun(b, store, 200)
	s := NewServer(store, platform.SystemClock{}, nil, nil, Config{Host: "localhost", Origin: "http://localhost"}, log.New(io.Discard, "", 0))
	s.Telemetry = tel
	return s.Handler(), boot.DeviceToken
}
