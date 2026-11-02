package auth

// Machine scopes (design §2.2): a bitmask on the machine, copied to each lease.
const (
	ScopeRead   int64 = 1 << iota // 1
	ScopePost                     // 2
	ScopeAsk                      // 4
	ScopeStatus                   // 8
	ScopeUpload                   // 16
	// ScopePage reads and screenshots the tab the owner shares with a conversation (page-share.feature). Its bit was "pickup"
	// (removed: nothing claims conversations); migration 0042 cleared it from every machine and lease, so an old grant never
	// becomes this one. The scopes column allows bits up to 64, so the free bit was the one to take.
	ScopePage           // 32
	ScopeCreateIdentity // 64
)

// DefaultScopes is what an approval gives when the owner changes nothing: read, post, ask, status, upload, page. A machine keeps the
// scopes of its approval, so page reaches only machines approved after it existed.
const DefaultScopes = ScopeRead | ScopePost | ScopeAsk | ScopeStatus | ScopeUpload | ScopePage

// scopeNames is in bit order, which is also the order the API lists them in.
var scopeNames = []string{"read", "post", "ask", "status", "upload", "page", "create_identity"}

// ScopeMask turns scope names into a bitmask. ok is false for an unknown name or an empty list.
func ScopeMask(names []string) (mask int64, ok bool) {
	for _, n := range names {
		found := false
		for bit, known := range scopeNames {
			if known != "" && n == known {
				mask |= 1 << bit
				found = true
			}
		}
		if !found {
			return 0, false
		}
	}
	return mask, mask != 0
}

// ScopeNames lists the names in a bitmask, in bit order. The result is never nil.
func ScopeNames(mask int64) []string {
	out := []string{}
	for bit, n := range scopeNames {
		if n != "" && mask&(1<<bit) != 0 {
			out = append(out, n)
		}
	}
	return out
}
