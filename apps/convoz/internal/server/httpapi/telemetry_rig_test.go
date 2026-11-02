package httpapi

import (
	"compress/gzip"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	colmetricpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/proto"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/telemetry"
)

// otlpToken is the header value the receiver expects; it must never appear in an exported body.
const otlpToken = "TESTONLY-otlp-token"

// receiver is a fake OTLP/HTTP collector. It keeps the REAL bytes the exporters send (after gzip), decoded and raw.
type receiver struct {
	srv *httptest.Server

	mu      sync.Mutex
	hits    int
	auth    []string
	metrics []*colmetricpb.ExportMetricsServiceRequest
	traces  []*coltracepb.ExportTraceServiceRequest
	raw     [][]byte
}

func newReceiver(t testing.TB) *receiver {
	t.Helper()
	r := &receiver{}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *receiver) serve(w http.ResponseWriter, req *http.Request) {
	var rd io.Reader = req.Body
	if req.Header.Get("Content-Encoding") == "gzip" {
		z, err := gzip.NewReader(req.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		rd = z
	}
	body, _ := io.ReadAll(rd)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hits++
	r.auth = append(r.auth, req.Header.Get("Authorization"))
	r.raw = append(r.raw, body)
	switch req.URL.Path {
	case "/v1/metrics":
		var m colmetricpb.ExportMetricsServiceRequest
		if proto.Unmarshal(body, &m) == nil {
			r.metrics = append(r.metrics, &m)
		}
		writeProto(w, &colmetricpb.ExportMetricsServiceResponse{})
	case "/v1/traces":
		var m coltracepb.ExportTraceServiceRequest
		if proto.Unmarshal(body, &m) == nil {
			r.traces = append(r.traces, &m)
		}
		writeProto(w, &coltracepb.ExportTraceServiceResponse{})
	default:
		http.NotFound(w, req)
	}
}

func writeProto(w http.ResponseWriter, m proto.Message) {
	out, _ := proto.Marshal(m)
	w.Header().Set("Content-Type", "application/x-protobuf")
	_, _ = w.Write(out)
}

// env is what os.Getenv would answer with telemetry on and pointed at this receiver.
func (r *receiver) env() func(string) string {
	return func(k string) string {
		switch k {
		case "OTEL_EXPORTER_OTLP_ENDPOINT":
			return r.srv.URL
		case "OTEL_EXPORTER_OTLP_HEADERS":
			return "authorization=" + otlpToken
		case "OTEL_METRIC_EXPORT_INTERVAL":
			return "3600000" // only ForceFlush exports, so a test sees one deterministic batch
		}
		return ""
	}
}

func (r *receiver) requests() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hits
}

// telRig is the whole public handler over a store opened the normal way (with the query observer), one owner, one conversation.
type telRig struct {
	h      http.Handler
	tel    *telemetry.Telemetry
	cookie string
	conv   int64
	s      *Server
	store  *pdb.Store
	owner  int64
}

func newTelRig(t *testing.T, tel *telemetry.Telemetry) *telRig {
	t.Helper()
	key := append([]byte("TESTONLY"), make([]byte, 24)...)
	store, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), key, pdb.WithQueryObserver(tel.ObserveQuery))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := platform.Migrate(context.Background(), store, platform.MigrateOptions{DataDir: t.TempDir(), Clock: platform.SystemClock{}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	boot, err := runBootstrap(store, bootstrapPorts, mintLink(t, store, now), "one", now)
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(store, platform.SystemClock{}, nil, nil, Config{Host: "localhost", Origin: "http://localhost"}, log.New(io.Discard, "", 0))
	s.Telemetry = tel
	rig := &telRig{h: s.Handler(), tel: tel, cookie: boot.DeviceToken, s: s, store: store, owner: boot.Owner.ID}
	if err := dbtest.TxErr(t, store, func(ctx context.Context, d pdb.DBTX) error {
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: boot.Owner.ID})
		rig.conv = cv.ID
		if err != nil {
			return err
		}
		return readstate.Create(ctx, d, now, boot.Owner.ID, cv.ID, 0)
	}); err != nil {
		t.Fatal(err)
	}
	return rig
}

// do sends one request through the whole chain as the signed-in owner's browser; headers override the defaults.
func (r *telRig) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	return r.send(r.cookie, method, path, body, headers)
}

func (r *telRig) send(cookie, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost"
	if cookie != "" {
		req.Header.Set("Cookie", DeviceCookie+"="+cookie)
	}
	for k, v := range writeHeaders {
		req.Header.Set(k, v)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec
}

// startTelemetry runs Setup against rcv and shuts it down with the test.
func startTelemetry(t testing.TB, rcv *receiver) *telemetry.Telemetry {
	t.Helper()
	tel, err := telemetry.Setup(context.Background(), rcv.env())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tel.Shutdown(context.Background()) })
	return tel
}

func flush(t *testing.T, tel *telemetry.Telemetry) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := tel.ForceFlush(ctx); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
}

// attrVal is an OTLP attribute value as a Go value: string, int64, bool, or the proto text for anything else.
func attrVal(v *commonpb.AnyValue) any {
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_IntValue:
		return x.IntValue
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue
	}
	return v.String()
}

// telemetryOffSetup is Setup with OTEL_EXPORTER_OTLP_ENDPOINT unset. The signal-specific endpoints and the headers point at rcv, so a
// stray exporter would reach it.
func telemetryOffSetup(rcv *receiver) (*telemetry.Telemetry, error) {
	return telemetry.Setup(context.Background(), func(k string) string {
		switch k {
		case "OTEL_EXPORTER_OTLP_HEADERS":
			return "authorization=" + otlpToken
		case "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT":
			return rcv.srv.URL + "/v1/metrics"
		case "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT":
			return rcv.srv.URL + "/v1/traces"
		}
		return ""
	})
}
