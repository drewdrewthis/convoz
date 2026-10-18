// Package tailnet reads Tailscale state by running the tailscale CLI (by argv, never a shell):
// the funnel check at start and node identity for a peer address (design §3.4).
package tailnet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// commandTimeout bounds every tailscale call so a hung daemon cannot hang the server.
const commandTimeout = 10 * time.Second

// ErrFunnelOn means funnel exposes this server to the public internet.
var ErrFunnelOn = errors.New("funnel must be off")

// run executes bin with args and returns stdout; a failure carries stderr.
func run(ctx context.Context, bin string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w: %s", bin, strings.Join(args, " "), err, strings.TrimSpace(errOut.String()))
	}
	return out.Bytes(), nil
}

// serveConfig is the part of Tailscale's ServeConfig that says what is exposed and to whom.
type serveConfig struct {
	TCP map[string]struct{ TCPForward string }
	Web map[string]struct {
		Handlers map[string]struct{ Proxy string }
	}
	AllowFunnel map[string]bool
	Foreground  map[string]*serveConfig
	Services    map[string]*serveConfig
}

// CheckFunnel fails with ErrFunnelOn when tailscale serves target to the public internet.
// target is the listen address "127.0.0.1:41000" or a socket path "/run/convoz/http.sock".
// Any other trouble (no binary, daemon down, unreadable output) is an error too: under
// --tailscale=check an unverifiable wall is not a wall.
func CheckFunnel(ctx context.Context, bin string, target string) error {
	out, err := run(ctx, bin, "serve", "status", "--json")
	if err != nil {
		return fmt.Errorf("cannot read tailscale status: %w", err)
	}
	return funnelOn(out, target)
}

// ErrFunnelTCPForward means funnel forwards raw TCP to the agent listener. A TCP forward carries no Tailscale-Funnel-Request header
// and no X-Forwarded-For, so the listener could not tell its clients apart (it would refuse every request); it must be a web proxy.
var ErrFunnelTCPForward = errors.New("funnel must proxy the agent listener as a web service, not forward TCP")

// CheckAgentFunnel fails with ErrFunnelTCPForward when tailscale forwards raw TCP from funnel to the agent listener at target.
// A funnel web proxy to it is what is wanted and passes.
func CheckAgentFunnel(ctx context.Context, bin string, target string) error {
	out, err := run(ctx, bin, "serve", "status", "--json")
	if err != nil {
		return fmt.Errorf("cannot read tailscale status: %w", err)
	}
	return agentFunnelTCP(out, target)
}

func agentFunnelTCP(status []byte, target string) error {
	var cfg serveConfig
	if err := json.Unmarshal(status, &cfg); err != nil {
		return fmt.Errorf("cannot read tailscale status: %w", err)
	}
	if hp, ok := cfg.forwards(target); ok {
		return fmt.Errorf("%w: funnel is on for %s", ErrFunnelTCPForward, hp)
	}
	return nil
}

// forwards looks through this config, every foreground session and every service for a funnel host:port whose TCP forward leads to target.
func (c *serveConfig) forwards(target string) (string, bool) {
	for hostPort, on := range c.AllowFunnel {
		if !on {
			continue
		}
		if _, port, err := net.SplitHostPort(hostPort); err == nil {
			if fwd, ok := c.TCP[port]; ok && sameTarget(fwd.TCPForward, target) {
				return hostPort, true
			}
		}
	}
	for _, group := range []map[string]*serveConfig{c.Foreground, c.Services} {
		for _, sub := range group {
			if sub == nil {
				continue
			}
			if hp, ok := sub.forwards(target); ok {
				return hp, true
			}
		}
	}
	return "", false
}

func funnelOn(status []byte, target string) error {
	var cfg serveConfig
	if err := json.Unmarshal(status, &cfg); err != nil {
		return fmt.Errorf("cannot read tailscale status: %w", err)
	}
	if hp, ok := cfg.exposes(target); ok {
		return fmt.Errorf("%w: tailscale funnel is on for %s and proxies this server", ErrFunnelOn, hp)
	}
	return nil
}

// exposes looks through this config, every foreground session and every service for a host:port
// that has funnel on and leads to target.
func (c *serveConfig) exposes(target string) (string, bool) {
	for hostPort, on := range c.AllowFunnel {
		if on && c.leadsTo(hostPort, target) {
			return hostPort, true
		}
	}
	for _, group := range []map[string]*serveConfig{c.Foreground, c.Services} {
		for _, sub := range group {
			if sub == nil {
				continue
			}
			if hp, ok := sub.exposes(target); ok {
				return hp, true
			}
		}
	}
	return "", false
}

// leadsTo reports whether the web handlers or the TCP forward behind hostPort reach target.
func (c *serveConfig) leadsTo(hostPort, target string) bool {
	for _, h := range c.Web[hostPort].Handlers {
		if sameTarget(h.Proxy, target) {
			return true
		}
	}
	if _, port, err := net.SplitHostPort(hostPort); err == nil {
		if fwd, ok := c.TCP[port]; ok && sameTarget(fwd.TCPForward, target) {
			return true
		}
	}
	return false
}

// sameTarget compares a Tailscale proxy value ("http://127.0.0.1:41000/x", "unix:/run/x.sock",
// "localhost:41000") with our listen target.
func sameTarget(proxy, target string) bool {
	if proxy == "" {
		return false
	}
	if path, ok := strings.CutPrefix(proxy, "unix:"); ok {
		return path == target
	}
	hostPort := proxy
	if u, err := url.Parse(proxy); err == nil && u.Host != "" {
		hostPort = u.Host
	}
	host, port, err := net.SplitHostPort(hostPort)
	if err != nil {
		return false
	}
	tHost, tPort, err := net.SplitHostPort(target)
	if err != nil || port != tPort {
		return false
	}
	return host == tHost || (host == "localhost" && net.ParseIP(tHost).IsLoopback())
}

// Node is a peer on the tailnet as whois reports it. Identity keys on the node (name and tags);
// a tagged node has no user (design amendment 7).
type Node struct {
	Name string
	Tags []string
}

// whoisArgs puts "--" before the address, so a hostile address such as "--help" is never read as a flag.
func whoisArgs(addr string) []string { return []string{"whois", "--json", "--", addr} }

// Whois asks tailscale who owns addr ("100.64.0.5" or "100.64.0.5:1234").
// Unused until S1b: the approve card and the machine wall are its callers.
func Whois(ctx context.Context, bin, addr string) (Node, error) {
	out, err := run(ctx, bin, whoisArgs(addr)...)
	if err != nil {
		return Node{}, err
	}
	return parseWhois(out)
}

func parseWhois(doc []byte) (Node, error) {
	var w struct {
		Node struct {
			Name string
			Tags []string
		}
	}
	if err := json.Unmarshal(doc, &w); err != nil {
		return Node{}, err
	}
	return Node{Name: strings.TrimSuffix(w.Node.Name, "."), Tags: w.Node.Tags}, nil
}
