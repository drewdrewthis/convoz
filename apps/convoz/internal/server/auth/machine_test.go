package auth

import (
	"bytes"
	"errors"
	"testing"
)

func TestScopeMaskRoundTrip(t *testing.T) {
	mask, ok := ScopeMask([]string{"read", "post", "ask", "status", "upload", "page"})
	if !ok || mask != DefaultScopes {
		t.Fatalf("default scopes: %d %v", mask, ok)
	}
	if got := ScopeNames(mask | ScopeCreateIdentity); len(got) != 7 || got[5] != "page" || got[6] != "create_identity" {
		t.Fatalf("names: %v", got)
	}
	for _, bad := range [][]string{nil, {}, {"read", "root"}} {
		if _, ok := ScopeMask(bad); ok {
			t.Errorf("%v must be refused", bad)
		}
	}
}

func TestAllowCovers(t *testing.T) {
	list := Allow{Mode: AllowList, IdentityIDs: []int64{7}, Globs: []string{"dev-*"}}
	cases := []struct {
		id     int64
		handle string
		want   bool
	}{{7, "docs", true}, {8, "dev-search", true}, {8, "docs", false}, {9, "dev", false}}
	for _, c := range cases {
		if got := list.Covers(c.id, c.handle); got != c.want {
			t.Errorf("list covers %d %q: got %v", c.id, c.handle, got)
		}
	}
	if !(Allow{Mode: AllowAny}).Covers(1, "anything") {
		t.Error("any covers every agent")
	}
	if list.CoversHandle("devtool") {
		t.Error("an identity that does not exist yet is covered by a glob only; devtool matches none")
	}
}

func TestKeyBoxBindsACopyToItsMachineAndVersion(t *testing.T) {
	box, err := NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed := box.Seal(3, 1, "cvz_m_TESTONLYkey")
	if got, err := box.Open(3, 1, sealed); err != nil || got != "cvz_m_TESTONLYkey" {
		t.Fatalf("open: %q %v", got, err)
	}
	for _, c := range [][2]int64{{4, 1}, {3, 2}} {
		if _, err := box.Open(c[0], c[1], sealed); !errors.Is(err, ErrKeyUnreadable) {
			t.Errorf("machine %d version %d must not open the copy: %v", c[0], c[1], err)
		}
	}
	if bytes.Contains(sealed, []byte("TESTONLY")) {
		t.Error("the sealed copy holds the key in the clear")
	}
}

func TestUserCodeShape(t *testing.T) {
	for range 50 {
		c := NewUserCode()
		if len(c) != 9 || c[4] != '-' {
			t.Fatalf("code %q", c)
		}
		for i, r := range c {
			if i != 4 && !containsRune(userCodeAlphabet, r) {
				t.Fatalf("code %q has %q", c, r)
			}
		}
	}
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
