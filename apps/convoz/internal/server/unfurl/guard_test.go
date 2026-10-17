package unfurl

import (
	"net/netip"
	"testing"
)

// Each refused range is named by an address inside it, near both ends, so a prefix typed wrong in refused is caught.
func TestPublicRefusesEveryRange(t *testing.T) {
	cases := map[string][]string{
		"this host":                {"0.0.0.0", "0.255.255.255"},
		"private 10/8":             {"10.0.0.5", "10.255.255.255"},
		"CGNAT 100.64/10":          {"100.64.0.1", "100.127.255.254"},
		"loopback 127/8":           {"127.0.0.1", "127.255.255.254"},
		"link-local and metadata":  {"169.254.169.254", "169.254.0.1"},
		"private 172.16/12":        {"172.16.0.1", "172.31.255.254"},
		"IETF protocol 192.0.0/24": {"192.0.0.8"},
		"documentation":            {"192.0.2.1", "198.51.100.1", "203.0.113.1"},
		"6to4 relay":               {"192.88.99.1"},
		"private 192.168/16":       {"192.168.1.1", "192.168.255.254"},
		"benchmark 198.18/15":      {"198.18.0.1", "198.19.255.254"},
		"multicast":                {"224.0.0.1", "239.255.255.255"},
		"reserved and broadcast":   {"240.0.0.1", "255.255.255.255"},
		"v6 unspecified":           {"::"},
		"v6 loopback":              {"::1"},
		"v4-compatible v6":         {"::7f00:1", "::a00:5"},
		"v4-mapped loopback":       {"::ffff:127.0.0.1", "::ffff:7f00:1"},
		"v4-mapped private":        {"::ffff:10.0.0.5", "::ffff:192.168.1.1", "::ffff:a9fe:a9fe"},
		"v4-mapped metadata":       {"::ffff:169.254.169.254"},
		"NAT64":                    {"64:ff9b::a00:5", "64:ff9b::7f00:1", "64:ff9b:1::1"},
		"v6 discard":               {"100::1"},
		"Teredo":                   {"2001:0:4136:e378:8000:63bf:3fff:fdd2"},
		"v6 documentation":         {"2001:db8::1"},
		"6to4":                     {"2002:a00:5::1", "2002:7f00:1::1"},
		"unique local":             {"fc00::1", "fd00:ec2::254", "fdff::1"},
		"v6 link-local":            {"fe80::1"},
		"v6 site-local":            {"fec0::1"},
		"v6 multicast":             {"ff02::1"},
	}
	for name, list := range cases {
		for _, s := range list {
			if Public(netip.MustParseAddr(s)) {
				t.Errorf("%s: %s must be refused", name, s)
			}
		}
	}
}

func TestPublicAllowsOrdinaryAddresses(t *testing.T) {
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "140.82.112.3", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "198.17.255.255",
		"198.20.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"} {
		if !Public(netip.MustParseAddr(s)) {
			t.Errorf("%s must be allowed", s)
		}
	}
}

func TestPublicRefusesZonedAndInvalid(t *testing.T) {
	if Public(netip.Addr{}) || Public(netip.MustParseAddr("2606:4700::1%eth0")) {
		t.Fatal("an invalid or zoned address must be refused")
	}
}
