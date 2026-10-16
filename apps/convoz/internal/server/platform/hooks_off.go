//go:build !testhooks

package platform

// MaxMigrationCap is 0 (no cap) in a release build.
func MaxMigrationCap() int { return 0 }
