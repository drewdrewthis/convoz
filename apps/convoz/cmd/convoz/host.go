package main

import (
	"fmt"
	"strconv"
	"strings"
)

// parseHost splits --host NAME[:PORT]. The port is the one clients type in the browser (the
// `tailscale serve --https=PORT` port); 443 is the default HTTPS port, so it normalises to 0 (none).
func parseHost(raw string) (name string, port int, err error) {
	name = strings.ToLower(raw)
	if i := strings.LastIndex(name, ":"); i >= 0 {
		p, perr := strconv.Atoi(name[i+1:])
		if perr != nil || p < 1 || p > 65535 {
			return "", 0, fmt.Errorf("--host %q: the port must be 1-65535", raw)
		}
		name, port = name[:i], p
		if port == 443 {
			port = 0
		}
	}
	if !hostRE.MatchString(name) {
		return "", 0, fmt.Errorf("--host %q is not a host name", raw)
	}
	return name, port, nil
}
