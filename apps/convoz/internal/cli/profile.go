package cli

import (
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Profile runs `convoz profile` to show the agent's own profile, or `convoz profile --set name=... description=...
// capabilities=a,b` to change it (once an hour). An agent changes only its own profile, never its handle.
func Profile(args []string, io IO) int {
	f := newChatFlags("profile", io)
	set := f.fs.Bool("set", false, "change the profile; the fields follow as name=..., description=..., capabilities=a,b")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) > 0 && !*set {
		return usageError(io, "usage: convoz profile [--set name=... description=... capabilities=a,b]")
	}
	var req wire.ProfileRequest
	if *set {
		if len(pos) == 0 {
			return usageError(io, "--set needs at least one of name=..., description=..., capabilities=...")
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
			default:
				return usageError(io, fmt.Sprintf("%q is not a profile field: name, description or capabilities", key))
			}
		}
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.ProfileResponse
	if *set {
		if err := k.callRetry("PATCH", wire.RouteProfile, req, &out); err != nil {
			return k.fail(err)
		}
	} else {
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
