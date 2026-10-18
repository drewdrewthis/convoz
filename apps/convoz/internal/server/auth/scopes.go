package auth

// Machine scopes (design §2.2): a bitmask on the machine, copied to each lease.
const (
	ScopeRead           int64 = 1 << iota // 1
	ScopePost                             // 2
	ScopeAsk                              // 4
	ScopeStatus                           // 8
	ScopeUpload                           // 16
	_                                     // 32: was "pickup", removed (owner: nothing claims conversations); the bit stays reserved
	ScopeCreateIdentity                   // 64
)

// DefaultScopes is what an approval gives when the owner changes nothing: read, post, ask, status, upload.
const DefaultScopes = ScopeRead | ScopePost | ScopeAsk | ScopeStatus | ScopeUpload

// scopeNames is in bit order, which is also the order the API lists them in.
var scopeNames = []string{"read", "post", "ask", "status", "upload", "", "create_identity"}

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
