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
		if *sid, err = sessionForAgent(io, dir, c, creds, *as, io.Getenv("CLAUDE_CODE_SESSION_ID")); err != nil {
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
		raw, _ := json.Marshal(map[string]any{"identity": me.Identity.Handle, "machine": me.Machine.Name, "session": *sid, "label": me.Session.Label, "live_sessions": me.LiveSessions, "scopes": me.Scopes})
		fmt.Fprintln(io.Stdout, string(raw))
		return ExitOK
	}
	fmt.Fprintf(io.Stdout, "identity: %s\nmachine: %s\nsession: %s (%s)\nlive sessions: %d\nscopes: %s\n", me.Identity.Handle, me.Machine.Name, *sid, plain(me.Session.Label), me.LiveSessions, strings.Join(me.Scopes, ", "))
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
// no longer honours is replaced. Without a client id there is nothing to match on, so it starts one. When `as` is a handle the
// agent had before (I-51), it warns on stderr for 30 days and then refuses, naming the new handle.
func sessionForAgent(io IO, dir string, c *client, creds Credentials, as, clientID string) (string, error) {
	as = strings.ToLower(as)
	if clientID != "" {
		if sid := findSession(dir, as, clientID); sid != "" {
			s, err := loadSession(dir, sid)
			if err != nil {
				return "", err
			}
			var me wire.MeResponse
			err = c.call(context.Background(), "GET", wire.RouteMe, s.Lease, nil, &me)
			if err == nil {
				return sid, followHandle(io, dir, sid, s, as, me)
			}
			if _, code := statusCode(err); code != wire.CodeSessionEnded {
				return sid, err
			}
		}
	}
	if clientID == "" {
		clientID = "convoz-" + randomHex(8)
	}
	return startSession(io, dir, c, creds, as, clientID, "convoz cli", nil, "") // no identity to make: only a rename warning prints
}

// followHandle keeps a session file true to the agent's handle now (it is rewritten on a change) and checks the handle the caller
// used: an old one works, with a warning, until the server says it no longer does.
func followHandle(io IO, dir, sid string, s sessionFile, as string, me wire.MeResponse) error {
	now := me.Identity.Handle
	if now != "" && (s.Identity != now || s.IdentityID != me.Identity.ID) {
		s.Identity, s.IdentityID = now, me.Identity.ID
		if s.As == "" {
			s.As = as
		}
		if path, ok := sessionPath(dir, sid); ok {
			if raw, err := json.Marshal(s); err == nil {
				_ = writePrivate(path, raw) // the lease still works: a file left as it was only costs a lookup
			}
		}
	}
	if as == now {
		return nil
	}
	for _, p := range me.Identity.PreviousHandles {
		if p.Handle != as {
			continue
		}
		if !p.Works {
			return renamedError(as, now)
		}
		warnRenamed(io, wire.Renamed{From: as, To: now, Until: p.Until})
	}
	return nil
}

// findSession returns the local id of the session file for (identity, clientID), or "".
func findSession(dir, identity, clientID string) string {
	entries, err := os.ReadDir(filepath.Join(dir, sessionsDir))
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if s, err := loadSession(dir, e.Name()); err == nil && s.names(identity) && s.ClientID == clientID {
			return e.Name()
		}
	}
	return ""
}
