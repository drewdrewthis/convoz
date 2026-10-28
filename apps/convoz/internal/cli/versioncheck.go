package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	now := time.Now()
	info := serverInfoFor(dir, server, Version, now, fetchServerInfo)
	switch decideVersion(Version, info, lastWarned(dir), now) {
	case versionRefuse:
		fmt.Fprintf(io.Stderr, "convoz cannot talk to this server (API %d here, %d there). Run: convoz upgrade\n", wire.APIVersion, info.API)
		return ExitOutOfDate
	case versionWarn:
		fmt.Fprintf(io.Stderr, "convoz: the server runs %s, you have %s. Still works; run: convoz upgrade\n", info.Version, Version)
		markWarned(dir, now)
	}
	return ExitOK
}

// versionAction is what a command does about the version of its server.
type versionAction int

const (
	versionRun    versionAction = iota // same version, or nothing to compare: run quietly
	versionWarn                        // the server is newer but speaks our API: run, and say so on stderr
	versionRefuse                      // the server speaks another API: stop
)

// versionWarnEvery is how often the "server is newer" line may print: a deploy every hour must not nag every command.
const versionWarnEvery = time.Hour

// versionWarnFile holds when the line last printed, in the config directory.
const versionWarnFile = "version-warned"

// decideVersion turns what the server said into an action. Only an API number that differs from ours refuses: with continuous deploys
// the commit differs almost always, and a CLI that stopped on that would stop every agent after every deploy. A server that names no
// API (API 0, one from before the field) is taken as compatible. warnedAt is when the warning last printed (zero: never).
func decideVersion(local string, server serverInfo, warnedAt, now time.Time) versionAction {
	if local == "" || local == "dev" {
		return versionRun
	}
	if server.API != 0 && server.API != wire.APIVersion {
		return versionRefuse
	}
	if !outOfDate(local, server.Version) {
		return versionRun
	}
	if age := now.Sub(warnedAt); !warnedAt.IsZero() && age >= 0 && age < versionWarnEvery {
		return versionRun
	}
	return versionWarn
}

// lastWarned is when the warning last printed; the zero time when it never did.
func lastWarned(dir string) time.Time {
	raw, err := os.ReadFile(filepath.Join(dir, versionWarnFile))
	if err != nil {
		return time.Time{}
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// markWarned keeps the time of the warning; best effort, as without it the next command warns again.
func markWarned(dir string, now time.Time) {
	_ = writePrivate(filepath.Join(dir, versionWarnFile), []byte(strconv.FormatInt(now.Unix(), 10)))
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
	API     int    `json:"api"`
	Local   string `json:"local"` // the CLI version that asked
	At      int64  `json:"at"`
}

// serverInfoFor is what server says it runs: the kept answer when it is under 10 minutes old, is for this server and was asked by this
// same CLI (local) or says local is up to date, else a new question to fetch. A kept answer asked by another binary (one from before
// an upgrade) never refuses a command. An answer that failed ("") is not kept, so the next command asks again.
func serverInfoFor(dir, server, local string, now time.Time, fetch func(server string) serverInfo) serverInfo {
	path := filepath.Join(dir, versionCacheFile)
	if raw, err := os.ReadFile(path); err == nil {
		var kept versionAnswer
		if json.Unmarshal(raw, &kept) == nil && kept.Server == server && kept.Version != "" && (kept.Local == local || !outOfDate(local, kept.Version)) {
			if age := now.Sub(time.Unix(kept.At, 0)); age >= 0 && age < versionCheckEvery {
				return serverInfo{kept.Version, kept.API}
			}
		}
	}
	v := fetch(server)
	if v.Version == "" {
		return serverInfo{}
	}
	if raw, err := json.Marshal(versionAnswer{Server: server, Version: v.Version, API: v.API, Local: local, At: now.Unix()}); err == nil {
		_ = writePrivate(path, raw) // best effort: without it the next command asks again
	}
	return v
}

// serverInfo is what GET /api/version says: the build, and the API number that only changes when old CLIs cannot talk to the server.
type serverInfo struct {
	Version string
	API     int
}

// serverVersion is the version alone, for callers that do not care about the API.
func serverVersion(dir, server, local string, now time.Time, fetch func(server string) string) string {
	return serverInfoFor(dir, server, local, now, func(s string) serverInfo { return serverInfo{Version: fetch(s)} }).Version
}

// fetchServerInfo asks GET /api/version; the zero value when the server cannot be reached or answers without a version.
func fetchServerInfo(server string) serverInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var got struct {
		Version string `json:"version"`
		API     int    `json:"api"`
	}
	if err := newClient(server).call(ctx, "GET", "/api/version", "", nil, &got); err != nil {
		return serverInfo{}
	}
	return serverInfo{got.Version, got.API}
}
