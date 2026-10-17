package crypto

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRotateKEKKeepsTheDEKsAndMovesTheKey(t *testing.T) {
	dir := t.TempDir()
	oldKEK, newKEK := testKEK, bytes.Repeat([]byte{7}, KEKSize)
	ring, err := OpenKeyring(dir, oldKEK, filepath.Join(dir, "convoz.db"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := RotateKEK(dir, oldKEK, newKEK); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKeyring(dir, oldKEK); !errors.Is(err, ErrKey) {
		t.Fatalf("the old KEK must not open the rotated keyring: %v", err)
	}
	rotated, err := LoadKeyring(dir, newKEK)
	if err != nil {
		t.Fatal(err)
	}
	for _, purpose := range purposes {
		a, _ := ring.DEK(purpose)
		b, _ := rotated.DEK(purpose)
		if !bytes.Equal(a, b) {
			t.Errorf("%s DEK changed", purpose)
		}
	}
}

func TestDestroyKeysRemovesKeyringAndKEK(t *testing.T) {
	dir := t.TempDir()
	kek := filepath.Join(dir, "kek")
	if err := os.WriteFile(kek, testKEK, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenKeyring(dir, testKEK, filepath.Join(dir, "convoz.db"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := DestroyKeys(dir, kek); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{kek, filepath.Join(dir, KeyringFile)} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still exists: %v", p, err)
		}
	}
}
