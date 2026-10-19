//go:build testhooks

package cli

import "os"

// testVersion lets a scenario make "a convoz older than its server": CONVOZ_TEST_VERSION is this binary's version. Only a testhooks build
// reads it, so no release binary can be made to lie about its version.
func testVersion(name string) string { return os.Getenv(name) }
