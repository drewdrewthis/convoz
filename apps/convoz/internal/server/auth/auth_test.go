package auth

import (
	"strings"
	"testing"
	"time"
)

func TestTokenShape(t *testing.T) {
	tok := newToken(PrefixBootstrap)
	if !strings.HasPrefix(tok, PrefixBootstrap) || len(tok) < len(PrefixBootstrap)+43 {
		t.Fatalf("bad token %q", tok)
	}
	for _, c := range strings.TrimPrefix(tok, PrefixBootstrap) {
		if !strings.ContainsRune(base62, c) {
			t.Fatalf("non-base62 character %q", c)
		}
	}
	if newToken(PrefixBootstrap) == tok {
		t.Fatal("two tokens are equal")
	}
	if string(hashToken(tok)) == string(hashToken(tok+"x")) || len(hashToken(tok)) != 32 {
		t.Fatal("hash is not a SHA-256 of the whole token")
	}
}

func TestLimiterWindowAndRefusalsAreNotCounted(t *testing.T) {
	l := Limiter{Window: time.Minute, Max: 2}
	t0 := time.Unix(1_000_000, 0)
	if !l.Allow("a", t0) || !l.Allow("a", t0.Add(time.Second)) {
		t.Fatal("first two hits must pass")
	}
	if l.Allow("a", t0.Add(30*time.Second)) {
		t.Fatal("third hit in the window must fail")
	}
	if !l.Allow("b", t0.Add(30*time.Second)) {
		t.Fatal("another key has its own count")
	}
	// The refused hit at +30s was not recorded: only the hit at t0 is out of the window at +61s.
	if !l.Allow("a", t0.Add(61*time.Second)) {
		t.Fatal("a hit must pass once the earlier ones left the window")
	}
}

func TestCeremonyIsSingleUseAndExpires(t *testing.T) {
	var s Ceremonies
	t0 := time.Unix(1_000_000, 0)
	id := s.Put(&Ceremony{Kind: "login"}, t0)
	if _, ok := s.Take(id, "register", t0); ok {
		t.Fatal("wrong kind must fail")
	}
	if _, ok := s.Take(id, "login", t0); ok {
		t.Fatal("a failed take still uses the ceremony up")
	}
	id = s.Put(&Ceremony{Kind: "login"}, t0)
	if _, ok := s.Take(id, "login", t0.Add(CeremonyTTL+time.Second)); ok {
		t.Fatal("an expired ceremony must fail")
	}
	id = s.Put(&Ceremony{Kind: "login"}, t0)
	if _, ok := s.Take(id, "login", t0.Add(time.Second)); !ok {
		t.Fatal("a fresh ceremony must be taken")
	}
	if _, ok := s.Take(id, "login", t0.Add(time.Second)); ok {
		t.Fatal("a ceremony works once")
	}
}

func TestRecoveryDeviceNeverSlides(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	normal := Device{LastSeen: t0}
	if !normal.NeedsSlide(t0.Add(SlideEvery)) {
		t.Fatal("a normal device slides after a minute")
	}
	recovery := Device{LastSeen: t0, Limited: true}
	if recovery.NeedsSlide(t0.Add(time.Hour)) {
		t.Fatal("a recovery device must never slide")
	}
}

func TestDestructiveActionsWaitForARecoveryPasskey(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	young := Passkey{DestructiveAt: t0.Add(RecoveryPasskeyDelay).UnixMilli()}
	for _, action := range []string{"passkey.remove", "recovery.regenerate"} {
		if err := CheckDestructive(young, action, t0.Add(2*time.Hour)); err != ErrPasskeyTooNew {
			t.Fatalf("%s inside the window: %v", action, err)
		}
		if err := CheckDestructive(young, action, t0.Add(RecoveryPasskeyDelay)); err != nil {
			t.Fatalf("%s after the window: %v", action, err)
		}
	}
	if err := CheckDestructive(young, "passkey.add", t0); err != nil {
		t.Fatalf("adding a passkey is not destructive: %v", err)
	}
}
