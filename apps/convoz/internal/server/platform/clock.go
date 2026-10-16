package platform

import "time"

// Clock is the time source; tests substitute a fixed one.
type Clock interface{ Now() time.Time }

// SystemClock reads the wall clock.
type SystemClock struct{}

// Now implements Clock.
func (SystemClock) Now() time.Time { return time.Now() }
