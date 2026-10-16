//go:build testhooks

package platform

import (
	"os"
	"strconv"
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
