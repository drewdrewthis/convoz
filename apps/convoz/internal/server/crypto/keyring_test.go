package crypto

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

var testKEK = append([]byte("TESTONLY"), bytes.Repeat([]byte{'.'}, 24)...)

func TestPublishNewFallbacks(t *testing.T) {
	cases := []struct {
		name   string
		link   error
		rename error
	}{
		{"link", nil, nil},
		{"link refused, renameat2", syscall.EPERM, nil},
		{"cross-device, renameat2", syscall.EXDEV, nil},
		{"no link, no renameat2: O_EXCL", syscall.ENOTSUP, syscall.ENOSYS},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			realLink, realRename := linkFile, renameFile
			t.Cleanup(func() { linkFile, renameFile = realLink, realRename })
			if c.link != nil {
				linkFile = func(string, string) error { return &os.LinkError{Op: "link", Err: c.link} }
			}
			if c.rename != nil {
				renameFile = func(string, string) error { return c.rename }
			}
			dir := t.TempDir()
			path := filepath.Join(dir, KeyringFile)
			if err := publishNew(dir, path, []byte("first")); err != nil {
				t.Fatal(err)
			}
			if got, _ := os.ReadFile(path); string(got) != "first" {
				t.Fatalf("keyring content %q", got)
			}
			// Never replaces an existing keyring, whichever path published the first one.
			err := publishNew(dir, path, []byte("second"))
			if !errors.Is(err, os.ErrExist) {
				t.Fatalf("second publish: got %v, want exists", err)
			}
			if got, _ := os.ReadFile(path); string(got) != "first" {
				t.Fatalf("keyring was replaced: %q", got)
			}
		})
	}
}

func TestOpenKeyringSweepsOldTemps(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	old := filepath.Join(dir, ".keyring-old")
	fresh := filepath.Join(dir, ".keyring-fresh")
	other := filepath.Join(dir, "keep-me")
	for _, p := range []string{old, fresh, other} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(old, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenKeyring(dir, testKEK, filepath.Join(dir, "convoz.db"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an old temp file survived the sweep")
	}
	for _, p := range []string{fresh, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s must survive: %v", p, err)
		}
	}
}

func TestOpenKeyringAddsTheMachineKeyDEKToAnOlderKeyring(t *testing.T) {
	dir := t.TempDir()
	g, err := aead(testKEK)
	if err != nil {
		t.Fatal(err)
	}
	w, dbDEK, err := newWrappedDEK(g, PurposeDB)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := json.Marshal(keyringDoc{Version: keyringVersion, KEKID: kekID(testKEK), DEKs: []wrappedDEK{w}})
	if err := publishNew(dir, filepath.Join(dir, KeyringFile), old); err != nil {
		t.Fatal(err)
	}

	first, err := OpenKeyring(dir, testKEK, filepath.Join(dir, "convoz.db"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	machine, ok := first.DEK(PurposeMachineKey)
	if !ok || len(machine) != 32 {
		t.Fatal("no machine key DEK was added")
	}
	if got, _ := first.DEK(PurposeDB); !bytes.Equal(got, dbDEK) {
		t.Fatal("the database DEK changed")
	}

	again, err := OpenKeyring(dir, testKEK, filepath.Join(dir, "convoz.db"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := again.DEK(PurposeMachineKey); !bytes.Equal(got, machine) {
		t.Fatal("the machine key DEK was not kept")
	}
	if info, err := os.Stat(filepath.Join(dir, KeyringFile)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("keyring mode: %v %v", info, err)
	}
}
