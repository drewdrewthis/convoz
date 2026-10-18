//go:build !testhooks

package identity

// beforeHandleChange is false in a release build: every database is migrated to the end.
func beforeHandleChange() bool { return false }
