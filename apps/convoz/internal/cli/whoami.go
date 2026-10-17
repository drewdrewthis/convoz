package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Whoami runs `convoz whoami`. With a session (--sid, or --as and the client id) it asks the server who the
// lease is; without one it reads only the local credentials file: the machine key stays a mint-only credential.
func Whoami(args []string, io IO) int {
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	fs.SetOutput(io.Stderr)
	sid := fs.String("sid", io.Getenv("CONVOZ_SID"), "the local session id")
	as := fs.String("as", io.Getenv("CONVOZ_AS"), "the agent handle; uses or starts the session of the client id")
	asJSON := fs.Bool("json", false, "print JSON")
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	creds, err := loadCredentials(dir, osKeychain{io.Getenv})
	if err != nil {
		return fail(io, err)
	}
	if *sid == "" && *as == "" {
		return printLocal(io, creds, *asJSON)
	}
	c := newClient(creds.Server)
	if *sid == "" {
		if *sid, err = sessionForAgent(dir, c, creds, *as, io.Getenv("CLAUDE_CODE_SESSION_ID")); err != nil {
			return sessionEnded(io, err)
		}
	}
	s, err := loadSession(dir, *sid)
	if err != nil {
		return sessionEnded(io, err)
	}
	var me wire.MeResponse
	if err := c.call(context.Background(), "GET", wire.RouteMe, s.Lease, nil, &me); err != nil {
		return sessionEnded(io, err)
	}
	if *asJSON {
		raw, _ := json.Marshal(map[string]any{"identity": me.Identity.Handle, "machine": me.Machine.Name, "session": *sid, "live_sessions": me.LiveSessions, "scopes": me.Scopes})
		fmt.Fprintln(io.Stdout, string(raw))
		return ExitOK
	}
	fmt.Fprintf(io.Stdout, "identity: %s\nmachine: %s\nsession: %s\nlive sessions: %d\nscopes: %s\n", me.Identity.Handle, me.Machine.Name, *sid, me.LiveSessions, strings.Join(me.Scopes, ", "))
	return ExitOK
}

func printLocal(io IO, creds Credentials, asJSON bool) int {
	if asJSON {
		raw, _ := json.Marshal(map[string]string{"machine": creds.Machine, "server": creds.Server})
		fmt.Fprintln(io.Stdout, string(raw))
		return ExitOK
	}
	fmt.Fprintf(io.Stdout, "machine: %s\nserver: %s\n", creds.Machine, creds.Server)
	return ExitOK
}

// sessionForAgent finds the live session of (as, clientID) or starts one. A session whose lease the server
// no longer honours is replaced. Without a client id there is nothing to match on, so it starts one.
func sessionForAgent(dir string, c *client, creds Credentials, as, clientID string) (string, error) {
	if clientID != "" {
		if sid := findSession(dir, as, clientID); sid != "" {
			s, err := loadSession(dir, sid)
			if err != nil {
				return "", err
			}
			err = c.call(context.Background(), "GET", wire.RouteMe, s.Lease, nil, nil)
			if _, code := statusCode(err); err == nil || code != wire.CodeSessionEnded {
				return sid, err
			}
		}
	}
	if clientID == "" {
		clientID = "convoz-" + randomHex(8)
	}
	return startSession(dir, c, creds, as, clientID, "convoz cli", false, "")
}

// findSession returns the local id of the session file for (identity, clientID), or "".
func findSession(dir, identity, clientID string) string {
	entries, err := os.ReadDir(filepath.Join(dir, sessionsDir))
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if s, err := loadSession(dir, e.Name()); err == nil && s.Identity == identity && s.ClientID == clientID {
			return e.Name()
		}
	}
	return ""
}
