package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

// shortTempDir is a private directory with a path short enough for a unix socket.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "convoz-sock-")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPeerCheckListenerDeniesAnUnreadablePeerOnLinux(t *testing.T) {
	if !peerCredRequired {
		t.Skip("SO_PEERCRED is Linux only")
	}
	path := filepath.Join(shortTempDir(t), "p.sock")
	ln, err := bindUnix(path)
	if err != nil {
		t.Fatal(err)
	}
	unreadable := peerCheckListener{UnixListener: ln, peer: func(*net.UnixConn) (uint32, bool) { return 0, false }}
	accepted := make(chan net.Conn, 1)
	go func() {
		if c, err := unreadable.Accept(); err == nil {
			accepted <- c
		}
	}()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("the server must close a peer it cannot identify, got %v", err)
	}
	select {
	case <-accepted:
		t.Fatal("an unidentified peer was accepted")
	default:
	}
	ln.Close()
}

func TestPeerCheckListenerAcceptsOurUidAndDeniesOthers(t *testing.T) {
	path := filepath.Join(shortTempDir(t), "q.sock")
	ln, err := bindUnix(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	uid := uint32(os.Getuid())
	var answer atomic.Uint32
	pl := peerCheckListener{UnixListener: ln, peer: func(*net.UnixConn) (uint32, bool) { return answer.Load(), true }}

	answer.Store(uid + 1)
	other, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	result := make(chan error, 1)
	go func() { _, err := pl.Accept(); result <- err }()
	_ = other.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := other.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("a foreign uid must be closed, got %v", err)
	}

	answer.Store(uid)
	mine, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer mine.Close()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("our own uid was not accepted")
	}
}

func TestSocketDirMustBePrivate(t *testing.T) {
	dir := shortTempDir(t)
	if err := checkSocketDir(filepath.Join(dir, "s.sock")); err != nil {
		t.Fatalf("a private directory passes: %v", err)
	}
	loose := filepath.Join(dir, "loose")
	if err := os.Mkdir(loose, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(loose, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := checkSocketDir(filepath.Join(loose, "s.sock")); !errors.Is(err, errSocketDirInsecure) {
		t.Fatalf("a world-writable directory must fail, got %v", err)
	}
	if _, code := bindPublic(listenSpec{unix: true, addr: filepath.Join(loose, "s.sock")}); code != exitWall {
		t.Fatalf("the public socket in a loose directory exits %d, want %d", code, exitWall)
	}
	if _, err := bindAdmin(filepath.Join(loose, "a.sock")); !errors.Is(err, errAdminInsecure) {
		t.Fatalf("the admin socket in a loose directory: %v", err)
	}
}
