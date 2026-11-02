// Package telemetry sends numbers, never content, to an OTLP/HTTP endpoint: request and query latencies and two web app counters.
// Every attribute is named here and every value is from a bounded set (a route pattern, a method, a status, a sqlc query name, an
// error class). No detector runs, so the resource is service.name and service.version only. Off unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

const (
	scope        = "convoz"
	defaultEvery = time.Minute
	maxQueryName = 64
	otherLabel   = "other"
)

// Unmatched is the http.route of a request no route of the table matched.
const Unmatched = "unmatched"

// buckets suit latencies from 100 µs to 5 s; the SDK default starts at 5 s and would put every request in one bucket.
var buckets = []float64{0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5}

// errorTypes is the bounded set of convoz.web.errors labels; anything else the app reports is "other".
var errorTypes = []string{"TypeError", "ReferenceError", "SyntaxError", "RangeError", "ChunkLoadError", otherLabel}

var methods = map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true, "OPTIONS": true}

// Telemetry is the handle the server records through. The zero value and a nil pointer are both a no-op.
type Telemetry struct {
	mp     *sdkmetric.MeterProvider
	tp     *sdktrace.TracerProvider
	tracer trace.Tracer
	// clock is the wall clock even under the test hooks: a latency must not follow a fake clock that tests move.
	clock platform.Clock

	httpDuration, dbDuration metric.Float64Histogram
	webErrors, sendFailures  metric.Int64Counter
	errorOpts                map[string][]metric.AddOption // per error type, built once so a report allocates no attribute set
	queryOpts                sync.Map                      // sqlc name -> []metric.RecordOption, built on the first query of that name
}

// Option changes Setup.
type Option func(*config)

type config struct{ version string }

// WithVersion sets service.version.
func WithVersion(v string) Option { return func(c *config) { c.version = v } }

// Setup reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS and OTEL_METRIC_EXPORT_INTERVAL through getenv. With the
// endpoint unset it returns a no-op Telemetry and opens no connection; a signal-specific endpoint alone does not turn it on.
func Setup(ctx context.Context, getenv func(string) string, opts ...Option) (*Telemetry, error) {
	endpoint := strings.TrimRight(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"), "/")
	if endpoint == "" {
		return &Telemetry{}, nil
	}
	if u, err := url.Parse(endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("telemetry: OTEL_EXPORTER_OTLP_ENDPOINT is not an http or https URL") // the value may hold a secret: not printed
	}
	cfg := config{version: "dev"}
	for _, o := range opts {
		o(&cfg)
	}
	headers := parseHeaders(getenv("OTEL_EXPORTER_OTLP_HEADERS"))
	every := defaultEvery
	if ms, err := strconv.Atoi(getenv("OTEL_METRIC_EXPORT_INTERVAL")); err == nil && ms > 0 {
		every = time.Duration(ms) * time.Millisecond
	}
	res := resource.NewSchemaless(attribute.String("service.name", "convoz"), attribute.String("service.version", cfg.version))

	// Explicit options win over the OTEL_* variables the exporters read from the process environment on their own.
	mexp, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(endpoint+"/v1/metrics"), otlpmetrichttp.WithHeaders(headers),
		otlpmetrichttp.WithCompression(otlpmetrichttp.GzipCompression))
	if err != nil {
		return nil, fmt.Errorf("telemetry: metric exporter: %w", err)
	}
	texp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint+"/v1/traces"), otlptracehttp.WithHeaders(headers),
		otlptracehttp.WithCompression(otlptracehttp.GzipCompression))
	if err != nil {
		_ = mexp.Shutdown(ctx)
		return nil, fmt.Errorf("telemetry: trace exporter: %w", err)
	}
	t := &Telemetry{
		mp: sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter{mexp, res}, sdkmetric.WithInterval(every))),
			sdkmetric.WithExemplarFilter(exemplar.AlwaysOffFilter),
		),
		tp:    sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(spanExporter{texp, res})),
		clock: platform.SystemClock{},
	}
	t.tracer = t.tp.Tracer(scope)
	if err := t.instruments(); err != nil {
		_ = t.Shutdown(ctx)
		return nil, err
	}
	return t, nil
}

func (t *Telemetry) instruments() error {
	m := t.mp.Meter(scope)
	var errs [4]error
	t.httpDuration, errs[0] = m.Float64Histogram("http.server.request.duration", metric.WithUnit("s"), metric.WithExplicitBucketBoundaries(buckets...))
	t.dbDuration, errs[1] = m.Float64Histogram("db.client.operation.duration", metric.WithUnit("s"), metric.WithExplicitBucketBoundaries(buckets...))
	t.webErrors, errs[2] = m.Int64Counter("convoz.web.errors", metric.WithUnit("{error}"))
	t.sendFailures, errs[3] = m.Int64Counter("convoz.web.send_failures", metric.WithUnit("{send}"))
	t.errorOpts = make(map[string][]metric.AddOption, len(errorTypes))
	for _, e := range errorTypes {
		t.errorOpts[e] = []metric.AddOption{metric.WithAttributeSet(attribute.NewSet(attribute.String("error.type", e)))}
	}
	return errors.Join(errs[:]...)
}

// Enabled reports whether an exporter is running.
func (t *Telemetry) Enabled() bool { return t != nil && t.mp != nil }

// ForceFlush exports everything recorded so far now (tests; also a clean exit).
func (t *Telemetry) ForceFlush(ctx context.Context) error {
	if !t.Enabled() {
		return nil
	}
	return errors.Join(t.tp.ForceFlush(ctx), t.mp.ForceFlush(ctx))
}

// Shutdown flushes and stops the exporters.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if !t.Enabled() {
		return nil
	}
	return errors.Join(t.tp.Shutdown(ctx), t.mp.Shutdown(ctx))
}

// Now is the start of a request to give ObserveRequest; the zero time when off.
func (t *Telemetry) Now() time.Time {
	if !t.Enabled() {
		return time.Time{}
	}
	return t.clock.Now()
}

// ObserveRequest records one served request that began at start: the route pattern (or Unmatched), its method and status. It also
// exports one server span with the same three attributes, made after the fact, so no context reaches the handlers.
func (t *Telemetry) ObserveRequest(start time.Time, route, method string, status int) {
	if !t.Enabled() {
		return
	}
	end := t.clock.Now()
	if !methods[method] {
		method = "_OTHER"
	}
	attrs := []attribute.KeyValue{
		attribute.String("http.route", route),
		attribute.String("http.request.method", method),
		attribute.Int("http.response.status_code", status),
	}
	t.httpDuration.Record(context.Background(), end.Sub(start).Seconds(), metric.WithAttributes(attrs...))
	_, span := t.tracer.Start(context.Background(), method+" "+route, trace.WithTimestamp(start), trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attrs...))
	if status >= 500 {
		span.SetStatus(codes.Error, "") // never a message: it could carry content
	}
	span.End(trace.WithTimestamp(end))
}

// ObserveQuery records one finished database statement: its SQL text (read only for the sqlc name, never exported) and duration.
// It runs once per statement, so it parses the first line only and reuses the attribute set of each name.
func (t *Telemetry) ObserveQuery(sql string, d time.Duration) {
	if !t.Enabled() {
		return
	}
	name := QueryName(sql)
	opts, ok := t.queryOpts.Load(name)
	if !ok {
		name = strings.Clone(name) // the key must not pin the whole SQL string it was cut from
		opts, _ = t.queryOpts.LoadOrStore(name, []metric.RecordOption{metric.WithAttributeSet(attribute.NewSet(attribute.String("db.operation.name", name)))})
	}
	t.dbDuration.Record(context.Background(), d.Seconds(), opts.([]metric.RecordOption)...)
}

// CountWebError counts one error report of the web app by its class. kind is matched exactly against the bounded set; anything
// else is "other". The report's text is never read.
func (t *Telemetry) CountWebError(kind string) {
	if !t.Enabled() {
		return
	}
	opts, ok := t.errorOpts[kind]
	if !ok {
		opts = t.errorOpts[otherLabel]
	}
	t.webErrors.Add(context.Background(), 1, opts...)
}

// CountSendFailure counts one message send the web app gave up on.
func (t *Telemetry) CountSendFailure() {
	if !t.Enabled() {
		return
	}
	t.sendFailures.Add(context.Background(), 1)
}

// QueryName is the sqlc name X of a first line "-- name: X :kind", when X is an identifier that starts with a capital and is at
// most 64 characters; else "other". The result is a substring of sql, so it allocates nothing.
func QueryName(sql string) string {
	rest, ok := strings.CutPrefix(sql, "-- name: ")
	if !ok {
		return otherLabel
	}
	end := strings.IndexAny(rest, " \n")
	if end < 0 {
		end = len(rest)
	}
	name := rest[:end]
	if name == "" || len(name) > maxQueryName || name[0] < 'A' || name[0] > 'Z' {
		return otherLabel
	}
	for i := 1; i < len(name); i++ {
		if c := name[i]; !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return otherLabel
		}
	}
	return name
}

// parseHeaders reads the OTEL_EXPORTER_OTLP_HEADERS form "k1=v1,k2=v2", values percent-encoded.
func parseHeaders(s string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(pair, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		if dec, err := url.PathUnescape(strings.TrimSpace(v)); err == nil {
			out[k] = dec
		}
	}
	return out
}

// metricExporter sends every batch with exactly res. The SDK merges OTEL_RESOURCE_ATTRIBUTES from the process environment into
// any resource it is given; this drops whatever that added.
type metricExporter struct {
	sdkmetric.Exporter
	res *resource.Resource
}

func (e metricExporter) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
	rm.Resource = e.res
	return e.Exporter.Export(ctx, rm)
}

// spanExporter is metricExporter for spans.
type spanExporter struct {
	sdktrace.SpanExporter
	res *resource.Resource
}

func (e spanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		out[i] = fixedResource{s, e.res}
	}
	return e.SpanExporter.ExportSpans(ctx, out)
}

type fixedResource struct {
	sdktrace.ReadOnlySpan
	res *resource.Resource
}

func (s fixedResource) Resource() *resource.Resource { return s.res }
