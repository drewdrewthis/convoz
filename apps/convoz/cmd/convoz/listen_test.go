package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseListen(t *testing.T) {
	ok := []string{"127.0.0.1:0", "127.0.0.1:8080", "[::1]:0", "unix:///tmp/x.sock"}
	for _, v := range ok {
		if _, err := parseListen(v); err != nil {
			t.Errorf("%s: %v", v, err)
		}
	}
	for _, v := range []string{"0.0.0.0:0", "192.0.2.10:0", "[::]:0", ":8080", "localhost:80"} {
		if _, err := parseListen(v); !errors.Is(err, errNotLoopback) {
			t.Errorf("%s: want not loopback, got %v", v, err)
		}
	}
	if _, err := parseListen("unix:///" + strings.Repeat("a", 120)); !errors.Is(err, errUnixPathLength) {
		t.Errorf("long path: %v", err)
	}
	if _, err := parseListen("unix://relative.sock"); !errors.Is(err, errBadListen) {
		t.Errorf("relative path: %v", err)
	}
	if _, err := parseListen("no-port"); !errors.Is(err, errBadListen) {
		t.Errorf("no port: %v", err)
	}
}

func TestBindUnixReplacesStaleAndRefusesLive(t *testing.T) {
	dir, err := os.MkdirTemp("", "convoz-sock-") // short: a unix path caps at 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	live, err := bindUnix(path)
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("socket mode %v, want 0600", info.Mode().Perm())
	}
	if _, err := bindUnix(path); !errors.Is(err, errSocketLive) {
		t.Fatalf("live socket: got %v", err)
	}
	// Close without unlinking leaves a stale socket file behind, as a crashed server would.
	live.SetUnlinkOnClose(false)
	live.Close()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("expected a stale socket file")
	}
	again, err := bindUnix(path)
	if err != nil {
		t.Fatalf("stale socket must be replaced: %v", err)
	}
	again.Close()
}
