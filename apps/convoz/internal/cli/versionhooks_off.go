//go:build !testhooks

package cli

// testVersion is the version a test says this binary is. A release binary has none: its version is the one it was built with.
func testVersion(string) string { return "" }
