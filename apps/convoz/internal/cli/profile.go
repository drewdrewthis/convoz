package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Profile runs `convoz profile` to show the agent's own profile, or `convoz profile --set name=... description=...
// capabilities=a,b` to change it (once an hour). An agent changes only its own profile. `handle=new` asks the owner for a new
// handle and waits, like `session start --create`, until the owner decides in Now; with --no-wait it prints the request (I-51).
func Profile(args []string, io IO) int {
	f := newChatFlags("profile", io)
	set := f.fs.Bool("set", false, "change the profile; the fields follow as name=..., description=..., capabilities=a,b, handle=...")
	noWait := f.fs.Bool("no-wait", false, "with handle=...: file the request and print it instead of waiting for the owner")
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
	if *noWait && handle == "" {
		return usageError(io, "--no-wait goes with handle=...")
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
		return k.askHandle(handle, !*noWait)
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

// askHandle asks the owner for the handle to and, when wait is set, asks again until the owner decides, the way `session start
// --create` waits for an identity. On approval the session file follows the new handle, and the old one keeps working for 30 days.
func (k *chatCmd) askHandle(to string, wait bool) int {
	req := wire.HandleRequest{Handle: to}
	deadline := time.Now().Add(waitForOwner)
	for announced := false; ; announced = true {
		var out struct {
			wire.HandleChanged
			Request *wire.HandleRequestState `json:"request"`
		}
		if err := k.callRetry("POST", wire.RouteHandle, req, &out); err != nil {
			return k.fail(describeHandleRefusal(err, to))
		}
		if out.Request == nil {
			k.followNewHandle(out.HandleChanged)
			if k.asJSON {
				k.printJSON(map[string]string{"handle": out.Identity.Handle, "previous_handle": out.Identity.PreviousHandle})
			} else {
				fmt.Fprintf(k.io.Stdout, "@%s is now @%s.\n", out.Identity.PreviousHandle, out.Identity.Handle)
			}
			return ExitOK
		}
		if !wait {
			if k.asJSON {
				k.printJSON(map[string]any{"request": out.Request})
			} else {
				fmt.Fprintf(k.io.Stdout, "Asked the owner for @%s: request %s waits in Now.\n", to, out.Request.Ref)
			}
			return ExitOK
		}
		req.Request = out.Request.Ref
		if !announced {
			fmt.Fprintf(k.io.Stderr, "convoz: Waiting for the owner to approve @%s. Open Convoz, Now.\n", to)
		}
		if !time.Now().Before(deadline) {
			return k.fail(fmt.Errorf("the owner has not decided yet: run the same command again to keep waiting: %w", errAwaitingOwner))
		}
		pause := time.Duration(out.Request.IntervalMs) * time.Millisecond
		if pause <= 0 {
			pause = defaultInterval
		}
		time.Sleep(pause)
	}
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

// describeHandleRefusal gives the refusals of a handle request their own words.
func describeHandleRefusal(err error, to string) error {
	status, code := statusCode(err)
	switch {
	case code == wire.CodeHandleTaken:
		return fmt.Errorf("@%s is taken or was used before. Pick another handle: %w", to, err)
	case code == wire.CodeRequestDenied:
		return fmt.Errorf("the owner denied the request for @%s: %w", to, err)
	case status == http.StatusGone:
		return fmt.Errorf("the request for @%s is gone: run the command again: %w", to, err)
	}
	return err
}
