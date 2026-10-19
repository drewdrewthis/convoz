package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// versionCheckEvery is how long the server's answer to "what version do you run" is kept: one question in 10 minutes, not one per command.
const versionCheckEvery = 10 * time.Minute

// versionCacheFile is the kept answer, in the config directory.
const versionCacheFile = "version-check"

// versionFree are the commands that run on any version. help and version are answered before the registry; whoami says what is wrong
// when something is; upgrade is the cure. login, mcp, hook, skill, man, setup and app run where a stop would hide the problem (a Claude Code hook,
// a stdio server, a login that has no server yet), and admin acts on the server's own socket.
var versionFree = map[string]bool{
	"help": true, "version": true, "whoami": true, "upgrade": true, "admin": true,
	"login": true, "mcp": true, "hook": true, "skill": true, "man": true, "setup": true, "app": true,
}

// outOfDate is true when the server runs another version than this CLI. A development build, or a server that names no version, never
// is: there is nothing to compare. The compare uses the short form, which is all the agent address shows.
func outOfDate(local, server string) bool {
	if local == "" || local == "dev" || server == "" {
		return false
	}
	return wire.ShortVersion(local) != wire.ShortVersion(server)
}

// versionGate stops a command with ExitOutOfDate and one line on stderr when this CLI is not the version of its server. It says
// nothing, and lets the command run, when it cannot tell: no login yet, a server that does not answer, a development build.
func versionGate(command string, io IO) int {
	if versionFree[command] || Version == "dev" {
		return ExitOK
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return ExitOK
	}
	server := credentialsServer(dir)
	if server == "" {
		return ExitOK
	}
	theirs := serverVersion(dir, server, time.Now(), fetchServerVersion)
	if !outOfDate(Version, theirs) {
		return ExitOK
	}
	fmt.Fprintf(io.Stderr, "convoz is out of date (you have %s, the server runs %s). Run: convoz upgrade\n", Version, theirs)
	return ExitOutOfDate
}

// credentialsServer is the server this machine logged in to, "" when it did not. It reads the file only: the key (and so the OS
// keychain) is not needed to ask a public question.
func credentialsServer(dir string) string {
	raw, err := os.ReadFile(filepath.Join(dir, credentialsFile))
	if err != nil {
		return ""
	}
	var c Credentials
	if json.Unmarshal(raw, &c) != nil {
		return ""
	}
	return c.Server
}

type versionAnswer struct {
	Server  string `json:"server"`
	Version string `json:"version"`
	At      int64  `json:"at"`
}

// serverVersion is the version server runs: the kept answer when it is under 10 minutes old and is for this server, else a new
// question to fetch. An answer that failed ("") is not kept, so the next command asks again.
func serverVersion(dir, server string, now time.Time, fetch func(server string) string) string {
	path := filepath.Join(dir, versionCacheFile)
	if raw, err := os.ReadFile(path); err == nil {
		var kept versionAnswer
		if json.Unmarshal(raw, &kept) == nil && kept.Server == server && kept.Version != "" {
			if age := now.Sub(time.Unix(kept.At, 0)); age >= 0 && age < versionCheckEvery {
				return kept.Version
			}
		}
	}
	v := fetch(server)
	if v == "" {
		return ""
	}
	if raw, err := json.Marshal(versionAnswer{Server: server, Version: v, At: now.Unix()}); err == nil {
		_ = writePrivate(path, raw) // best effort: without it the next command asks again
	}
	return v
}

// fetchServerVersion asks GET /api/version; "" when the server cannot be reached or answers without a version.
func fetchServerVersion(server string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var got struct {
		Version string `json:"version"`
	}
	if err := newClient(server).call(ctx, "GET", "/api/version", "", nil, &got); err != nil {
		return ""
	}
	return got.Version
}
