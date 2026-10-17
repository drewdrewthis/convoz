package testroutes

// The test routes of the unfurl module (testhooks build only; scripts/release_guard.py checks a release binary has none).
const (
	// UnfurlFixture stands in for a site: {host, target} makes the host resolve to a made-up public address whose connections go to the
	// fixture server at target ("127.0.0.1:port"); {host, resolves} makes the host resolve to that address only.
	UnfurlFixture = "/__test/unfurl-fixture"
)

func init() { All = append(All, UnfurlFixture) }
