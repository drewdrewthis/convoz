package cli

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Profile runs `convoz profile` to show the agent's own profile, or `convoz profile --set name=... description=...
// capabilities=a,b` to change it (once an hour). An agent changes only its own profile. `handle=new` renames the agent at once, no
// approval (I-51); the old handle keeps reaching it for 30 days.
func Profile(args []string, io IO) int {
	f := newChatFlags("profile", io)
	set := f.fs.Bool("set", false, "change the profile; the fields follow as name=..., description=..., capabilities=a,b, handle=...")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) > 0 && !*set {
		return usageError(io, "usage: convoz profile [--set name=... description=... capabilities=a,b handle=...]")
	}
	var req wire.ProfileRequest
	var handle string
	if *set {
		if len(pos) == 0 {
			return usageError(io, "--set needs at least one of name=..., description=..., capabilities=..., handle=...")
		}
		for _, p := range pos {
			key, value, ok := strings.Cut(p, "=")
			switch {
			case !ok:
				return usageError(io, fmt.Sprintf("%q is not name=value", p))
			case key == "name":
				req.DisplayName = &value
			case key == "description":
				req.Description = &value
			case key == "capabilities":
				caps := []string{}
				for _, c := range strings.Split(value, ",") {
					if c = strings.TrimSpace(c); c != "" {
						caps = append(caps, c)
					}
				}
				req.Capabilities = &caps
			case key == "handle":
				if handle = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "@")); handle == "" {
					return usageError(io, "handle= needs the new handle")
				}
			default:
				return usageError(io, fmt.Sprintf("%q is not a profile field: name, description, capabilities or handle", key))
			}
		}
	}
	words := req.DisplayName != nil || req.Description != nil || req.Capabilities != nil
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.ProfileResponse
	if *set && words {
		if err := k.callRetry("PATCH", wire.RouteProfile, req, &out); err != nil {
			return k.fail(err)
		}
	}
	if handle != "" {
		return k.changeHandle(handle)
	}
	if !*set {
		var me wire.MeResponse
		if err := k.callRetry("GET", wire.RouteMe, nil, &me); err != nil {
			return k.fail(err)
		}
		out = wire.ProfileResponse{Handle: me.Identity.Handle, DisplayName: me.Identity.DisplayName, Description: me.Identity.Description, Capabilities: me.Identity.Capabilities}
	}
	if out.Capabilities == nil {
		out.Capabilities = []string{}
	}
	if k.asJSON {
		k.printJSON(out)
		return ExitOK
	}
	fmt.Fprintf(k.io.Stdout, "%s @%s\n%s\ncapabilities: %s\n", plain(out.DisplayName), out.Handle, plain(out.Description), plain(strings.Join(out.Capabilities, ", ")))
	return ExitOK
}

// changeHandle renames the agent to the handle to. The session file follows the new handle, and the old one keeps working for 30 days.
func (k *chatCmd) changeHandle(to string) int {
	var out wire.HandleChanged
	if err := k.callRetry("POST", wire.RouteHandle, wire.HandleChange{Handle: to}, &out); err != nil {
		return k.fail(describeHandleRefusal(err, to))
	}
	k.followNewHandle(out)
	if k.asJSON {
		k.printJSON(map[string]any{"handle": out.Identity.Handle, "previous_handle": out.Identity.PreviousHandle, "previous_until": out.Identity.PreviousUntil})
		return ExitOK
	}
	fmt.Fprintf(k.io.Stdout, "You are now @%s. Old @%s works until %s.\n", out.Identity.Handle, out.Identity.PreviousHandle, time.UnixMilli(out.Identity.PreviousUntil).UTC().Format("2006-01-02"))
	return ExitOK
}

// followNewHandle rewrites the session file of this command to the agent's new handle; the handle it was started with stays, so
// `--as old` still finds it (I-51).
func (k *chatCmd) followNewHandle(ch wire.HandleChanged) {
	if k.sid == "" {
		return
	}
	s, err := loadSession(k.dir, k.sid)
	path, ok := sessionPath(k.dir, k.sid)
	if err != nil || !ok {
		return
	}
	if s.As == "" {
		s.As = s.Identity
	}
	s.Identity, s.IdentityID = ch.Identity.Handle, ch.Identity.ID
	if raw, err := json.Marshal(s); err == nil {
		_ = writePrivate(path, raw) // the lease works either way; the next command rewrites a file left as it was
	}
}

// describeHandleRefusal gives the refusals of a handle change their own words.
func describeHandleRefusal(err error, to string) error {
	if _, code := statusCode(err); code == wire.CodeHandleTaken {
		return fmt.Errorf("@%s is taken or was used before. Pick another handle: %w", to, err)
	}
	return err
}
