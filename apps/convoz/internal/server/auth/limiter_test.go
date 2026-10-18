package auth

import (
	"fmt"
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

func TestLimiterMapStaysBoundedUnderALiveFlood(t *testing.T) {
	l := Limiter{Window: time.Hour, Max: 1}
	now := time.Unix(1_800_000_000, 0)
	for i := 0; i < 3*maxKeys; i++ {
		l.Allow(fmt.Sprintf("k%d", i), now.Add(time.Duration(i)*time.Millisecond)) // every key is live in the window
	}
	if len(l.hits) > maxKeys+1 {
		t.Fatalf("%d keys held, want at most %d", len(l.hits), maxKeys+1)
	}
}
