package cli

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"
)

// The retry rule of a command that retries (design §12.3): up to 5 tries, each bounded, with exponential backoff and full
// jitter between them, on a lost connection, a 429 (Retry-After is honoured) and a 5xx; never on any other 4xx. A mutating
// request carries one client id for all its tries, so a retry after a lost answer never stores a second copy (I-24).
const (
	retryTries     = 5
	retryBase      = 500 * time.Millisecond
	retryCap       = 15 * time.Second
	attemptTimeout = 15 * time.Second
	// maxSlowDown is the longest a command spends waiting in all for a busy or slow server before it gives up: the dead-link
	// bound of 90 seconds.
	maxSlowDown = 90 * time.Second
)

// callRetry is call with the retry rule. The last error is returned when the tries or the time run out; its exit code
// then says why (5 for a rate limit, 6 for a link that does not answer).
func (k *chatCmd) callRetry(method, path string, in, out any) error {
	started := time.Now()
	for try := 1; ; try++ {
		timeout := min(k.timeout, attemptTimeout)
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		err := k.c.withTimeout(timeout).call(ctx, method, path, k.lease, in, out)
		cancel()
		wait, again := pause(err, try)
		if !again || try >= retryTries || time.Since(started)+wait > maxSlowDown {
			return err
		}
		time.Sleep(wait)
	}
}

// pause says whether err is worth another try and how long to wait before it.
func pause(err error, try int) (wait time.Duration, again bool) {
	if err == nil {
		return 0, false
	}
	backoff := rand.N(min(retryCap, retryBase<<(try-1)) + 1)
	var se *statusError
	switch {
	case errors.Is(err, errUnreachable):
		return backoff, true
	case !errors.As(err, &se):
		return 0, false
	case se.status == 429:
		if se.retryAfter > 0 {
			return se.retryAfter, true
		}
		return backoff, true
	case se.status >= 500:
		return backoff, true
	}
	return 0, false
}
