//go:build !testhooks

package auth

// beforeIdentityRequests is false in a release build: every database is migrated to the end.
func beforeIdentityRequests() bool { return false }
