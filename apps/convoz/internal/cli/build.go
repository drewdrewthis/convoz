package cli

import (
	"context"
	"fmt"
	"runtime/debug"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Commit is the source revision of this binary; "unknown" when the build carries none.
var Commit = "unknown"

// SetBuild fixes Version and Commit for this process. linked is the version the build stamped with -ldflags -X ("dev" when none):
// without one, the version is the source revision, so a server and the CLI it serves, built from one tree, agree without a release
// step to keep in sync.
func SetBuild(linked string) {
	rev, modified := "", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.modified":
				modified = s.Value == "true"
			}
		}
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	if rev != "" {
		Commit = rev
		if modified {
			Commit += "+dirty"
		}
	}
	Version = linked
	if (linked == "" || linked == "dev") && rev != "" {
		Version = Commit
	}
}

// VersionLine is the first line of `convoz version`: the version and the commit.
func VersionLine() string { return fmt.Sprintf("convoz %s commit %s", Version, Commit) }

// WarnIfStale tells the user, on stderr, when the server runs another version than this CLI. A server that cannot be asked, or
// answers without a version, is not an error here: the command the user ran will say what is wrong.
func WarnIfStale(io IO, c *client) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var got struct {
		Version string `json:"version"`
	}
	if err := c.call(ctx, "GET", "/api/version", "", nil, &got); err != nil || got.Version == "" || wire.ShortVersion(got.Version) == wire.ShortVersion(Version) {
		return
	}
	fmt.Fprintf(io.Stderr, "convoz: warning: this CLI is %s and the server is %s. update: curl -fsSL %s/install | sh\n", Version, got.Version, c.base)
}
