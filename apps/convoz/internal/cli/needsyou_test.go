package cli

import (
	"strings"
	"testing"
)

func TestPostNeedsYouFlags(t *testing.T) {
	var c created
	run := agentRun(t, convServer(&c, devtool, drew))

	if code, _, stderr := run(Post, "--fyi", "7", "Green"); code != ExitOK || stderr != "" {
		t.Fatalf("--fyi: exit %d stderr %q", code, stderr)
	}
	if c.post.NeedsYou == nil || *c.post.NeedsYou {
		t.Errorf("--fyi must send needs_you false, got %v", c.post.NeedsYou)
	}
	if code, _, stderr := run(Post, "7", "Green"); code != ExitOK || !strings.Contains(stderr, "--fyi") {
		t.Errorf("no flag: exit %d stderr %q, want a hint", code, stderr)
	}
	c.post.NeedsYou = nil
	code, _, stderr := run(Post, "--needs-you", "7", "Ship it?")
	if code != ExitUsage || !strings.Contains(stderr, "convoz ask") || c.post.NeedsYou != nil {
		t.Errorf("--needs-you: exit %d stderr %q posted %v", code, stderr, c.post.NeedsYou)
	}
}
