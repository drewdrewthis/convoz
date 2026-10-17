package unfurl

import "net/netip"

// refused lists the ranges a link preview must never reach: this host, private networks, shared address space (CGNAT),
// link-local (which holds the cloud metadata service at 169.254.169.254), documentation and benchmark ranges, multicast and
// reserved space, and for IPv6 the loopback, unique-local (fc00::/7, which holds the metadata address fd00:ec2::254),
// link-local, site-local, multicast and the ranges that embed an IPv4 address (NAT64, 6to4, Teredo) because a firewall
// that checks only the outer address would let an embedded private one through.
var refused = prefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
	"fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
)

func prefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(list))
	for i, s := range list {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// Public says whether the preview worker may connect to the address. An IPv4 address wrapped in IPv6 (::ffff:10.0.0.5) is
// judged as the IPv4 address it carries.
func Public(addr netip.Addr) bool {
	a := addr.Unmap()
	if !a.IsValid() || a.Zone() != "" || !a.IsGlobalUnicast() {
		return false
	}
	for _, p := range refused {
		if p.Contains(a) {
			return false
		}
	}
	return true
}
