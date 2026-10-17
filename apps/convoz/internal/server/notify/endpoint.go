package notify

import (
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// pushHosts are the push services a browser may name, matched exactly (I-28): no suffix match, so
// fcm.googleapis.com.evil.tld is refused.
var pushHosts = map[string]bool{
	"fcm.googleapis.com":                true, // Chrome, Edge, Brave, Opera on Android and desktop
	"updates.push.services.mozilla.com": true, // Firefox
	"web.push.apple.com":                true, // Safari and Home Screen apps
}

// windowsHost is Windows Notification Service: one lowercase label under notify.windows.com (wns2-by3p.notify.windows.com).
var windowsHost = regexp.MustCompile(`^[a-z0-9-]+\.notify\.windows\.com$`)

var (
	extraMu    sync.Mutex
	extraHosts = map[string]bool{}
)

// AllowHost adds one exact host to the allow-list. Only the test build calls it, for its fake push service.
func AllowHost(host string) {
	extraMu.Lock()
	defer extraMu.Unlock()
	extraHosts[strings.ToLower(host)] = true
}

// MaxEndpoint is the longest endpoint the table takes.
const MaxEndpoint = 1024

// AllowedEndpoint reports whether the endpoint is https on a known push service, with no user info and no port.
func AllowedEndpoint(raw string) bool {
	if len(raw) > MaxEndpoint {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Opaque != "" || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host != strings.ToLower(host) || u.Host != host {
		return false
	}
	extraMu.Lock()
	extra := extraHosts[host]
	extraMu.Unlock()
	return pushHosts[host] || windowsHost.MatchString(host) || extra
}

// HostOf is the host of a stored endpoint, for the list the owner sees (the endpoint itself is a capability and stays private).
func HostOf(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Host
	}
	return ""
}
