//go:build !testhooks

package platform

import "time"

// MaxMigrationCap is 0 (no cap) in a release build.
func MaxMigrationCap() int { return 0 }

// NewClock is the wall clock in a release build.
func NewClock() Clock { return SystemClock{} }

// TokenMarker is empty in a release build: real tokens carry no marker.
func TokenMarker() string { return "" }

// PollIntervalOverride is never set in a release build.
func PollIntervalOverride() (time.Duration, bool) { return 0, false }
