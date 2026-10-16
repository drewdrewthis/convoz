package auth

import (
	"testing"
	"time"
)

func TestRetryAfterIsTheWaitUntilTheOldestHitLeavesTheWindow(t *testing.T) {
	l := Limiter{Window: time.Hour, Max: 2}
	t0 := time.Unix(1_800_000_000, 0)
	if got := l.RetryAfter("k", t0); got != 0 {
		t.Errorf("no hits: %v", got)
	}
	l.Allow("k", t0)
	l.Allow("k", t0.Add(10*time.Minute))
	if l.Allow("k", t0.Add(20*time.Minute)) {
		t.Fatal("the third hit is over the limit")
	}
	if got := l.RetryAfter("k", t0.Add(20*time.Minute)); got != 40*time.Minute {
		t.Errorf("the first hit leaves at t0+1h: %v", got)
	}
	if got := l.RetryAfter("k", t0.Add(61*time.Minute)); got != 0 {
		t.Errorf("room again after the first hit left: %v", got)
	}
	if got := l.RetryAfter("other", t0); got != 0 {
		t.Errorf("keys are independent: %v", got)
	}
}
