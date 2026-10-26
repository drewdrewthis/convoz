package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestQueryNameIsTheSqlcNameOfTheFirstLine(t *testing.T) {
	cases := []struct{ name, sql, want string }{
		{"a sqlc query", "-- name: GetKV :one\nSELECT value FROM system_kv WHERE key = ?", "GetKV"},
		{"an exec query", "-- name: SetKV :exec\nINSERT INTO system_kv VALUES (?, ?)", "SetKV"},
		{"no name line", "SELECT 1", "other"},
		{"a pragma", "PRAGMA journal_mode=WAL", "other"},
		{"an empty statement", "", "other"},
		{"a name that is not an identifier", "-- name: x'; DROP TABLE t :one\nSELECT 1", "other"},
		{"a lowercase name", "-- name: getKV :one\nSELECT 1", "other"},
		{"a name on a later line", "SELECT 1\n-- name: GetKV :one", "other"},
		{"an overlong name", "-- name: A" + repeat("b", 200) + " :one\nSELECT 1", "other"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := QueryName(c.sql); got != c.want {
				t.Errorf("QueryName = %q, want %q", got, c.want)
			}
		})
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func TestSetupWithNoEndpointIsAnOffNoOpThatNeverTouchesTheNetwork(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits.Add(1) }))
	defer srv.Close()
	// Everything but the endpoint is set, so a leak of any other variable into the exporter would show.
	tel, err := Setup(context.Background(), envOf(map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer TESTONLY", "OTEL_SERVICE_NAME": "x"}))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("is not enabled", func(t *testing.T) {
		if tel.Enabled() {
			t.Error("Enabled() = true with OTEL_EXPORTER_OTLP_ENDPOINT unset")
		}
	})
	t.Run("records and flushes without error", func(t *testing.T) {
		tel.ObserveQuery("-- name: GetKV :one\nSELECT 1", time.Millisecond)
		ctx := context.Background()
		if err := tel.ForceFlush(ctx); err != nil {
			t.Errorf("ForceFlush: %v", err)
		}
		if err := tel.Shutdown(ctx); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	t.Run("sends no request", func(t *testing.T) {
		if n := hits.Load(); n != 0 {
			t.Errorf("%d requests, want 0", n)
		}
	})
}

func TestANilTelemetryIsSafeToCall(t *testing.T) {
	var tel *Telemetry
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("a nil Telemetry panicked: %v", r)
		}
	}()
	tel.ObserveQuery("SELECT 1", time.Millisecond)
	_ = tel.ForceFlush(context.Background())
	_ = tel.Shutdown(context.Background())
	if tel.Enabled() {
		t.Error("a nil Telemetry is enabled")
	}
}

func TestSetupWithAnEndpointIsEnabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	tel, err := Setup(context.Background(), envOf(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": srv.URL}))
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())
	if !tel.Enabled() {
		t.Error("Enabled() = false with OTEL_EXPORTER_OTLP_ENDPOINT set")
	}
}
