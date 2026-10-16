//go:build testhooks

package platform

import (
	"os"
	"strconv"
	"sync"
	"time"
)

// HooksEnabled reports whether the testhooks build was also switched on at run time.
func HooksEnabled() bool { return os.Getenv("CONVOZ_TEST_ADMIN") == "1" }

// MaxMigrationCap caps migrations to simulate the previous release; 0 means no cap.
func MaxMigrationCap() int {
	if !HooksEnabled() {
		return 0
	}
	n, _ := strconv.Atoi(os.Getenv("CONVOZ_TEST_MAX_MIGRATION"))
	return n
}

// TestClock is the wall clock plus an offset the tests can move, or a frozen instant.
// Real time keeps flowing unless frozen, so a CLI that polls in real time still works.
type TestClock struct {
	base   SystemClock
	mu     sync.Mutex
	offset time.Duration
	frozen *time.Time
}

// Now implements Clock.
func (c *TestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen != nil {
		return *c.frozen
	}
	return c.base.Now().Add(c.offset)
}

// Advance moves the clock forward (a frozen clock moves its frozen instant).
func (c *TestClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen != nil {
		t := c.frozen.Add(d)
		c.frozen = &t
		return
	}
	c.offset += d
}

// Freeze stops the clock at the current instant.
func (c *TestClock) Freeze() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen == nil {
		t := c.base.Now().Add(c.offset)
		c.frozen = &t
	}
}

// Unfreeze lets the clock run again from the frozen instant.
func (c *TestClock) Unfreeze() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen != nil {
		c.offset = c.frozen.Sub(c.base.Now())
		c.frozen = nil
	}
}

// NewClock is a *TestClock when the hooks are switched on, else the wall clock.
func NewClock() Clock {
	if HooksEnabled() {
		return &TestClock{}
	}
	return SystemClock{}
}

// TokenMarker makes every minted token start with TESTONLY, so a leaked fake is recognisable.
func TokenMarker() string {
	if HooksEnabled() {
		return "TESTONLY"
	}
	return ""
}

// PollIntervalOverride is the device-flow poll interval a test asks for with CONVOZ_TEST_POLL_MS, so a CLI
// login takes milliseconds. The clock is never frozen for this: a frozen clock would answer slow_down forever.
func PollIntervalOverride() (time.Duration, bool) {
	if !HooksEnabled() {
		return 0, false
	}
	ms, err := strconv.Atoi(os.Getenv("CONVOZ_TEST_POLL_MS"))
	return time.Duration(ms) * time.Millisecond, err == nil && ms > 0
}
