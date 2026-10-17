//go:build testhooks

package unfurl

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// The test build can stand in for the internet, so a scenario can serve a page on 127.0.0.1 and a host name that "resolves to
// 10.0.0.5" without any real DNS. Nothing here loosens the rules: a fixture host resolves to a made-up public address that the
// guard accepts for what it is, and only the last step, connecting, is sent to the fixture. A literal 127.0.0.1 in a link is
// still refused, and so is a redirect to one. Nothing happens unless the run also set CONVOZ_TEST_ADMIN=1.
var fixtures = struct {
	sync.Mutex
	hosts   map[string]netip.Addr // host name -> the address it resolves to
	serving map[netip.Addr]string // made-up public address -> the fixture's real "127.0.0.1:port"
	next    byte
}{hosts: map[string]netip.Addr{"localhost": netip.MustParseAddr("127.0.0.1")}, serving: map[netip.Addr]string{}}

// ServeFixture makes host (a name or name:port is matched by name) resolve to a public-looking address whose connections go to
// target, the real "127.0.0.1:port" of a fixture server. It returns the address the host resolves to.
func ServeFixture(host, target string) netip.Addr {
	fixtures.Lock()
	defer fixtures.Unlock()
	fixtures.next++
	ip := netip.AddrFrom4([4]byte{9, 9, 9, fixtures.next})
	fixtures.hosts[host] = ip
	fixtures.serving[ip] = target
	return ip
}

// ResolveFixture makes host resolve to ip and nothing else, for a scenario about a name that points at a private address.
func ResolveFixture(host string, ip netip.Addr) {
	fixtures.Lock()
	defer fixtures.Unlock()
	fixtures.hosts[host] = ip
}

type fixtureResolver struct{}

func (fixtureResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	fixtures.Lock()
	defer fixtures.Unlock()
	if ip, ok := fixtures.hosts[host]; ok {
		return []netip.Addr{ip}, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func withFixtures(f *Fetcher) *Fetcher {
	if !platform.HooksEnabled() {
		return f
	}
	f.resolver = fixtureResolver{}
	f.plainTLS = true
	f.connect = func(ctx context.Context, ip netip.Addr, port string) (net.Conn, error) {
		fixtures.Lock()
		target, ok := fixtures.serving[ip]
		fixtures.Unlock()
		if !ok {
			return nil, fmt.Errorf("unfurl test build: no fixture serves %s", ip)
		}
		var d net.Dialer
		return d.DialContext(ctx, "tcp", target)
	}
	return f
}
