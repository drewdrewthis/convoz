package httpapi

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

// The HARD RULE of the OTLP export: numbers and bounded labels only, never content. This test runs real traffic that carries content
// (ids, a query, a user agent, a message body, an error report) with telemetry on, captures the REAL serialized OTLP bodies the
// exporters send, and asserts an allowlist over every field. A new label, metric, scope, span name or resource attribute fails here
// until a reviewer adds it to the lists below ON PURPOSE.

const sentinel = "sentinel" // every content string this test sends contains it; matched case-insensitively

var (
	allowedMetrics = map[string]bool{
		"http.server.request.duration": true,
		"db.client.operation.duration": true,
		"convoz.web.errors":            true,
		"convoz.web.send_failures":     true,
	}
	// the datapoint attribute keys each metric may carry
	allowedPointKeys = map[string][]string{
		"http.server.request.duration": {"http.route", "http.request.method", "http.response.status_code"},
		"db.client.operation.duration": {"db.operation.name"},
		"convoz.web.errors":            {"error.type"},
		"convoz.web.send_failures":     {},
	}
	allowedSpanKeys   = []string{"http.route", "http.request.method", "http.response.status_code", "db.operation.name"}
	allowedResource   = []string{"service.name", "service.version"}
	errorTypes        = []string{"TypeError", "ReferenceError", "SyntaxError", "RangeError", "ChunkLoadError", "other"}
	httpMethods       = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "_OTHER"}
	dbNameRe          = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	scopeRe           = regexp.MustCompile(`^(convoz|github\.com/drewdrewthis/convoz/[A-Za-z0-9_./-]*)$`)
	forbiddenKeyParts = []string{"url.path", "url.query", "url.full", "user_agent", "client.address", "client.port", "server.address", "server.port", "net.peer", "net.host", "net.sock", "enduser", "host.name", "host.id", "process.", "os.type", "os.description", "telemetry.sdk", "http.target", "http.url", "http.user_agent", "http.client_ip", "db.statement", "db.query", "db.system"}
)

func registeredPatterns() []string {
	var out []string
	for _, rt := range Routes {
		out = append(out, rt.Pattern)
	}
	return out
}

// walkAttrs reports every attribute key in a list, and the key's value.
type attrSink func(where, key string, val any)

func sinkAll(where string, kvs []*commonpb.KeyValue, f attrSink) {
	for _, kv := range kvs {
		f(where, kv.Key, attrVal(kv.Value))
	}
}

// capture runs the traffic and returns what the receiver got after one forced flush.
func captureTraffic(t *testing.T) (*receiver, *telRig) {
	t.Helper()
	rcv := newReceiver(t)
	tel := startTelemetry(t, rcv)
	rig := newTelRig(t, tel)
	ua := map[string]string{"User-Agent": "SentinelBrowser/9.9 (SentinelOS)"}
	conv := fmt.Sprintf("%d", rig.conv)

	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/conversations/" + conv + "?q=SentinelQueryText", "", 200},
		{"POST", "/api/conversations/" + conv + "/messages", `{"client_id":"sentinel-client-id-1","body":"SentinelMessageBody private words"}`, 0},
		{"GET", "/api/nope/SentinelUnknownPath", "", 404},
		{"POST", "/api/client-errors", `{"kind":"TypeError","message":"TypeError: SentinelErrorMessage","stack":"at SentinelStack (/a.js:1:1)","page":"/SentinelPage?x=SentinelPageQuery","build":"SentinelBuild","ua":"SentinelUA"}`, 204},
		{"POST", "/api/client-errors", `{"kind":"SentinelKindNotInTheEnum","message":"RangeError: SentinelOther"}`, 204},
		{"POST", "/api/client-events", `{"event":"send_failed","message":"SentinelEventExtra"}`, 204},
	} {
		rec := rig.do(c.method, c.path, c.body, ua)
		if c.want != 0 && rec.Code != c.want {
			t.Fatalf("%s %s: status %d, want %d (%s)", c.method, c.path, rec.Code, c.want, rec.Body.String())
		}
	}
	flush(t, tel)
	return rcv, rig
}

func TestExportedTelemetryHoldsOnlyAllowlistedNumbersAndBoundedLabels(t *testing.T) {
	rcv, _ := captureTraffic(t)
	rcv.mu.Lock()
	defer rcv.mu.Unlock()
	patterns := registeredPatterns()

	if len(rcv.metrics) == 0 || len(rcv.traces) == 0 {
		t.Fatalf("exports: %d metric requests, %d trace requests; want both", len(rcv.metrics), len(rcv.traces))
	}

	var resources []*resourcepb.Resource
	var scopes []*commonpb.InstrumentationScope
	var scopeNames []string
	seenMetric := map[string]bool{}
	var spans []*tracepb.Span
	var badKeys, badValues, exemplars []string

	checkPoint := func(metric string, attrs []*commonpb.KeyValue) {
		allowed := allowedPointKeys[metric]
		sinkAll(metric, attrs, func(where, key string, val any) {
			if !slices.Contains(allowed, key) {
				badKeys = append(badKeys, fmt.Sprintf("%s: attribute %q", where, key))
				return
			}
			if msg := checkLabel(key, val, patterns); msg != "" {
				badValues = append(badValues, fmt.Sprintf("%s: %s", where, msg))
			}
		})
	}
	for _, req := range rcv.metrics {
		for _, rm := range req.ResourceMetrics {
			resources = append(resources, rm.Resource)
			for _, sm := range rm.ScopeMetrics {
				scopes = append(scopes, sm.Scope)
				for _, m := range sm.Metrics {
					seenMetric[m.Name] = true
					if !allowedMetrics[m.Name] {
						badKeys = append(badKeys, "metric name "+m.Name)
					}
					switch d := m.Data.(type) {
					case *metricspb.Metric_Sum:
						for _, p := range d.Sum.DataPoints {
							checkPoint(m.Name, p.Attributes)
							for range p.Exemplars {
								exemplars = append(exemplars, m.Name)
							}
						}
					case *metricspb.Metric_Histogram:
						for _, p := range d.Histogram.DataPoints {
							checkPoint(m.Name, p.Attributes)
							for range p.Exemplars {
								exemplars = append(exemplars, m.Name)
							}
						}
					case *metricspb.Metric_Gauge:
						for _, p := range d.Gauge.DataPoints {
							checkPoint(m.Name, p.Attributes)
							for range p.Exemplars {
								exemplars = append(exemplars, m.Name)
							}
						}
					default:
						badKeys = append(badKeys, fmt.Sprintf("metric %s has an unexpected data type %T", m.Name, m.Data))
					}
				}
			}
		}
	}
	var spanErrs []string
	for _, req := range rcv.traces {
		for _, rs := range req.ResourceSpans {
			resources = append(resources, rs.Resource)
			for _, ss := range rs.ScopeSpans {
				scopes = append(scopes, ss.Scope)
				spans = append(spans, ss.Spans...)
			}
		}
	}
	for _, sc := range scopes {
		scopeNames = append(scopeNames, sc.GetName())
	}
	for _, sp := range spans {
		spanErrs = append(spanErrs, checkSpan(sp, patterns)...)
	}

	t.Run("every resource attribute is service.name or service.version", func(t *testing.T) {
		for _, r := range resources {
			for _, kv := range r.GetAttributes() {
				if !slices.Contains(allowedResource, kv.Key) {
					t.Errorf("resource attribute %q", kv.Key)
				}
			}
		}
	})
	t.Run("service.name is convoz", func(t *testing.T) {
		for _, r := range resources {
			got := ""
			for _, kv := range r.GetAttributes() {
				if kv.Key == "service.name" {
					got = kv.Value.GetStringValue()
				}
			}
			if got != "convoz" {
				t.Errorf("service.name = %q", got)
			}
		}
	})
	t.Run("every scope name is a convoz one and no scope carries attributes", func(t *testing.T) {
		for _, sc := range scopes {
			if !scopeRe.MatchString(sc.GetName()) || len(sc.GetAttributes()) != 0 {
				t.Errorf("scope %q with %d attributes", sc.GetName(), len(sc.GetAttributes()))
			}
		}
	})
	t.Run("only allowlisted metric names and datapoint attribute keys are exported", func(t *testing.T) {
		if len(badKeys) != 0 {
			t.Errorf("%s", strings.Join(badKeys, "\n"))
		}
	})
	t.Run("every datapoint attribute value is in its bounded set", func(t *testing.T) {
		if len(badValues) != 0 {
			t.Errorf("%s", strings.Join(badValues, "\n"))
		}
	})
	t.Run("every allowed metric the traffic exercises is exported", func(t *testing.T) {
		for name := range allowedMetrics {
			if !seenMetric[name] {
				t.Errorf("metric %s was not exported", name)
			}
		}
	})
	t.Run("no datapoint carries an exemplar", func(t *testing.T) {
		if len(exemplars) != 0 {
			t.Errorf("exemplars on %v", exemplars)
		}
	})
	t.Run("at least one span is exported", func(t *testing.T) {
		if len(spans) == 0 {
			t.Error("no spans")
		}
	})
	t.Run("every span has an allowlisted name, no events, no links, no status text and only allowlisted attributes", func(t *testing.T) {
		if len(spanErrs) != 0 {
			t.Errorf("%s", strings.Join(spanErrs, "\n"))
		}
	})
	t.Run("no forbidden attribute key appears in the raw bytes of any export", func(t *testing.T) {
		for _, body := range rcv.raw {
			low := strings.ToLower(string(body))
			for _, part := range forbiddenKeyParts {
				if strings.Contains(low, part) {
					t.Errorf("forbidden key part %q in an export", part)
				}
			}
		}
	})
	t.Run("no content string reaches any export body", func(t *testing.T) {
		for _, body := range rcv.raw {
			if strings.Contains(strings.ToLower(string(body)), sentinel) {
				t.Errorf("content leaked: the export holds %q", sentinel)
			}
		}
	})
	t.Run("no SQL text reaches any export body", func(t *testing.T) {
		for _, body := range rcv.raw {
			low := strings.ToLower(string(body))
			for _, frag := range []string{"select ", "insert into", "update ", "delete from", "-- name:"} {
				if strings.Contains(low, frag) {
					t.Errorf("SQL fragment %q in an export", frag)
				}
			}
		}
	})
	t.Run("the OTLP header value stays in the header and out of the body", func(t *testing.T) {
		for _, body := range rcv.raw {
			if strings.Contains(string(body), otlpToken) {
				t.Error("the OTLP auth token is in a body")
			}
		}
	})
	t.Run("the exporter sends the configured Authorization header", func(t *testing.T) {
		for _, a := range rcv.auth {
			if a != otlpToken {
				t.Errorf("Authorization = %q", a)
			}
		}
	})
	t.Run("the http metric is in seconds", func(t *testing.T) {
		for _, req := range rcv.metrics {
			for _, rm := range req.ResourceMetrics {
				for _, sm := range rm.ScopeMetrics {
					for _, m := range sm.Metrics {
						if m.Name == "http.server.request.duration" && m.Unit != "s" {
							t.Errorf("unit %q", m.Unit)
						}
					}
				}
			}
		}
	})
	_ = scopeNames
}

// checkLabel returns "" when val is a legal value of the allowlisted attribute key.
func checkLabel(key string, val any, patterns []string) string {
	s, isStr := val.(string)
	switch key {
	case "http.route":
		if !isStr || (s != "unmatched" && !slices.Contains(patterns, s)) {
			return fmt.Sprintf("http.route %v is not a registered pattern or unmatched", val)
		}
	case "http.request.method":
		if !isStr || !slices.Contains(httpMethods, s) {
			return fmt.Sprintf("http.request.method %v", val)
		}
	case "http.response.status_code":
		n, ok := val.(int64)
		if !ok || n < 100 || n > 599 {
			return fmt.Sprintf("http.response.status_code %v (%T) is not an int status", val, val)
		}
	case "db.operation.name":
		if !isStr || (s != "other" && !dbNameRe.MatchString(s)) {
			return fmt.Sprintf("db.operation.name %v", val)
		}
	case "error.type":
		if !isStr || !slices.Contains(errorTypes, s) {
			return fmt.Sprintf("error.type %v is not in the enum", val)
		}
	}
	return ""
}

func checkSpan(sp *tracepb.Span, patterns []string) []string {
	var errs []string
	if !spanNameOK(sp.Name, patterns) {
		errs = append(errs, fmt.Sprintf("span name %q", sp.Name))
	}
	if len(sp.Events) != 0 {
		errs = append(errs, fmt.Sprintf("span %q has %d events", sp.Name, len(sp.Events)))
	}
	if len(sp.Links) != 0 {
		errs = append(errs, fmt.Sprintf("span %q has %d links", sp.Name, len(sp.Links)))
	}
	if sp.Status != nil && sp.Status.Message != "" {
		errs = append(errs, fmt.Sprintf("span %q has a status message", sp.Name))
	}
	sinkAll(sp.Name, sp.Attributes, func(where, key string, val any) {
		if !slices.Contains(allowedSpanKeys, key) {
			errs = append(errs, fmt.Sprintf("span %s: attribute %q", where, key))
		} else if msg := checkLabel(key, val, patterns); msg != "" {
			errs = append(errs, fmt.Sprintf("span %s: %s", where, msg))
		}
	})
	return errs
}

// spanNameOK: a route pattern, "METHOD pattern", "unmatched", "METHOD unmatched", or a sqlc query name ("db.Name" or "Name" or "other").
func spanNameOK(name string, patterns []string) bool {
	if method, rest, ok := strings.Cut(name, " "); ok && slices.Contains(httpMethods, method) {
		name = rest
	}
	return name == "unmatched" || slices.Contains(patterns, name) || name == "other" || dbNameRe.MatchString(strings.TrimPrefix(name, "db."))
}

func TestWithTelemetryOffNoRequestIsEverSentAndHandlersStillWork(t *testing.T) {
	rcv := newReceiver(t)
	// OTEL_EXPORTER_OTLP_ENDPOINT is unset: the receiver is reachable through the other variables yet must stay untouched.
	tel, err := telemetryOffSetup(rcv)
	if err != nil {
		t.Fatal(err)
	}
	rig := newTelRig(t, tel)
	conv := fmt.Sprintf("%d", rig.conv)
	t.Run("a request is served", func(t *testing.T) {
		if rec := rig.do("GET", "/api/conversations/"+conv, "", nil); rec.Code != http.StatusOK {
			t.Errorf("status %d", rec.Code)
		}
	})
	t.Run("a client event is accepted", func(t *testing.T) {
		if rec := rig.do("POST", "/api/client-events", `{"event":"send_failed"}`, nil); rec.Code != http.StatusNoContent {
			t.Errorf("status %d", rec.Code)
		}
	})
	t.Run("the receiver sees no request after a flush", func(t *testing.T) {
		flush(t, tel)
		if n := rcv.requests(); n != 0 {
			t.Errorf("%d requests, want 0", n)
		}
	})
}
