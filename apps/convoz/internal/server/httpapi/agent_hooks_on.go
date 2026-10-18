//go:build testhooks

package httpapi

import (
	"os"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// agentPeerTrusted lets a test client with no Funnel proxy in front (the real CLI) be known by its peer address. The test build
// only, and only with CONVOZ_TEST_ADMIN=1 and CONVOZ_TEST_AGENT_PEER=1; a release build never trusts a bare peer.
func agentPeerTrusted() bool {
	return platform.HooksEnabled() && os.Getenv("CONVOZ_TEST_AGENT_PEER") == "1"
}
