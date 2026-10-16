//go:build !testhooks

package platform

// HooksEnabled is false in a release build: the test routes are never registered.
func HooksEnabled() bool { return false }

// MaxMigrationCap is 0 (no cap) in a release build.
func MaxMigrationCap() int { return 0 }
