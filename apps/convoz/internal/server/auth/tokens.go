// Package auth owns credentials: passkeys, device sessions, step-ups, recovery codes and bootstrap links.
// Functions take the module's sqlc Queries, so the caller decides which transaction they join.
package auth

import (
	"crypto/rand"
	"crypto/sha256"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// Token prefixes (design §2.1). A prefix lets secret scanners find a leaked token.
const (
	PrefixBootstrap = "cvz_b_"
	PrefixDevice    = "cvz_d_"
	PrefixRecovery  = "cvz_r_"
	PrefixMachine   = "cvz_m_"
	PrefixSession   = "cvz_s_"
	PrefixDeviceReq = "cvz_c_" // the device code of the machine login flow
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// randomBase62 returns n random base62 characters. Bytes of 248 and above are skipped, so every
// character is equally likely (256 is not a multiple of 62).
func randomBase62(n int) string {
	out := make([]byte, 0, n)
	buf := make([]byte, n*2)
	for len(out) < n {
		if _, err := rand.Read(buf); err != nil {
			panic("crypto/rand failed: " + err.Error())
		}
		for _, b := range buf {
			if b < 248 && len(out) < n {
				out = append(out, base62[b%62])
			}
		}
	}
	return string(out)
}

// newToken is a 256-bit bearer token. A testhooks build adds a TESTONLY marker after the prefix.
func newToken(prefix string) string { return prefix + platform.TokenMarker() + randomBase62(43) }

// hashToken is the stored form of every bearer token: SHA-256.
func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
