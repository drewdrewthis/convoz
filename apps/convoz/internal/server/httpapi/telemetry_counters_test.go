package httpapi

import (
	"fmt"
	"strings"
	"testing"

	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
)

// counter returns the exported value of a counter, summed over the datapoints whose attributes equal want (nil: no attributes).
// ok is false when the counter was not exported at all.
func (r *receiver) counter(name string, want map[string]string) (total int64, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, req := range r.metrics {
		for _, rm := range req.ResourceMetrics {
			for _, sm := range rm.ScopeMetrics {
				for _, m := range sm.Metrics {
					sum, isSum := m.Data.(*metricspb.Metric_Sum)
					if m.Name != name || !isSum {
						continue
					}
					for _, p := range sum.Sum.DataPoints {
						got := map[string]string{}
						for _, kv := range p.Attributes {
							got[kv.Key] = fmt.Sprint(attrVal(kv.Value))
						}
						if fmt.Sprint(got) == fmt.Sprint(orEmpty(want)) {
							total += p.GetAsInt()
							ok = true
						}
					}
				}
			}
		}
	}
	return total, ok
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func TestSendFailedEventCountsOneSendFailureWithNoLabels(t *testing.T) {
	rcv := newReceiver(t)
	tel := startTelemetry(t, rcv)
	rig := newTelRig(t, tel)
	rig.do("POST", "/api/client-events", sendFailed, nil)
	rig.do("POST", "/api/client-events", `{"event":"unknown_thing"}`, nil) // refused: counts nothing
	flush(t, tel)
	got, ok := rcv.counter("convoz.web.send_failures", nil)
	if !ok || got != 1 {
		t.Errorf("convoz.web.send_failures = %d (exported %v), want 1 with no attributes", got, ok)
	}
}

func TestClientErrorCountsByTheReportedClassOnly(t *testing.T) {
	rcv := newReceiver(t)
	tel := startTelemetry(t, rcv)
	rig := newTelRig(t, tel)
	for _, body := range []string{
		`{"kind":"TypeError","message":"x"}`,
		`{"kind":"TypeError","message":"y"}`,
		`{"kind":"ChunkLoadError","message":"Loading chunk 3 failed"}`,
		`{"kind":"SomethingElseEntirely","message":"TypeError: this text names a class"}`, // unknown class: other, not TypeError
		`{"message":"ReferenceError: x is not defined"}`,                                  // no class: other, never read from the text
		`{"kind":"typeerror","message":"m"}`,                                              // the enum is exact
	} {
		if rec := rig.do("POST", "/api/client-errors", body, nil); rec.Code != 204 {
			t.Fatalf("%s: status %d", body, rec.Code)
		}
	}
	flush(t, tel)
	for class, want := range map[string]int64{"TypeError": 2, "ChunkLoadError": 1, "other": 3, "ReferenceError": 0} {
		t.Run("error.type "+class, func(t *testing.T) {
			got, ok := rcv.counter("convoz.web.errors", map[string]string{"error.type": class})
			if want == 0 {
				if ok && got != 0 {
					t.Errorf("= %d, want none", got)
				}
				return
			}
			if !ok || got != want {
				t.Errorf("convoz.web.errors{error.type=%s} = %d (exported %v), want %d", class, got, ok, want)
			}
		})
	}
}

func TestClientErrorMessageTextNeverBecomesALabel(t *testing.T) {
	rcv := newReceiver(t)
	tel := startTelemetry(t, rcv)
	rig := newTelRig(t, tel)
	rig.do("POST", "/api/client-errors", `{"kind":"TypeError","message":"SentinelLabelText: boom","stack":"SentinelStackText"}`, nil)
	flush(t, tel)
	rcv.mu.Lock()
	defer rcv.mu.Unlock()
	for _, body := range rcv.raw {
		if strings.Contains(strings.ToLower(string(body)), "sentinel") {
			t.Error("the report text reached an export")
		}
	}
}
