//go:build !testhooks

package unfurl

// withFixtures is the identity in a release: there is no fixture table to consult.
func withFixtures(f *Fetcher) *Fetcher { return f }
