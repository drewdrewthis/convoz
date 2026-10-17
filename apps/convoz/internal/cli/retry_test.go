package cli

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestPause_RetriesOnlyWhatPasses(t *testing.T) {
	cases := []struct {
		name  string
		err   error
		again bool
		wait  time.Duration // 0: any wait up to the backoff
	}{
		{"no error", nil, false, 0},
		{"lost connection", fmt.Errorf("%w: cannot reach", errUnreachable), true, 0},
		{"rate limited with Retry-After", &statusError{status: 429, retryAfter: 3 * time.Second}, true, 3 * time.Second},
		{"rate limited without it", &statusError{status: 429}, true, 0},
		{"server fault", &statusError{status: 503}, true, 0},
		{"client error", &statusError{status: 400, code: "invalid_request"}, false, 0},
		{"conflict", &statusError{status: 409}, false, 0},
		{"not an http answer", errors.New("unreadable"), false, 0},
	}
	for _, c := range cases {
		wait, again := pause(c.err, 1)
		if again != c.again || (c.wait != 0 && wait != c.wait) || wait > retryBase+c.wait {
			t.Errorf("%s: pause = %v, %v", c.name, wait, again)
		}
	}
}

func TestPause_BackoffIsBoundedByTheCap(t *testing.T) {
	for try := 1; try <= retryTries; try++ {
		if wait, _ := pause(&statusError{status: 500}, try); wait > retryCap {
			t.Fatalf("try %d waits %v, over the cap %v", try, wait, retryCap)
		}
	}
}
