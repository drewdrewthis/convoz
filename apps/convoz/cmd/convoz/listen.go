package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// maxUnixPath is the longest socket path sockaddr_un holds (108 bytes with the terminating NUL).
const maxUnixPath = 107

// Errors serve maps to exit codes.
var (
	errNotLoopback    = errors.New("not loopback")
	errBadListen      = errors.New("bad listen address")
	errSocketLive     = errors.New("a live server already listens there")
	errAdminInsecure  = errors.New("admin socket cannot be secured")
	errUnixPathLength = fmt.Errorf("socket path is longer than %d bytes", maxUnixPath)
)

// listenSpec is a parsed --listen value.
type listenSpec struct {
	unix bool
	addr string // "127.0.0.1:41000", or the socket path
}

// parseListen accepts a loopback IP with a port, or unix:///absolute/path.sock. Nothing else:
// the server never binds a tailnet or public address (design §3.4).
func parseListen(v string) (listenSpec, error) {
	if path, ok := strings.CutPrefix(v, "unix://"); ok {
		if !filepath.IsAbs(path) {
			return listenSpec{}, fmt.Errorf("%w: %q needs an absolute socket path", errBadListen, v)
		}
		if len(path) > maxUnixPath {
			return listenSpec{}, fmt.Errorf("%w: %s", errUnixPathLength, path)
		}
		return listenSpec{unix: true, addr: path}, nil
	}
	host, _, err := net.SplitHostPort(v)
	if err != nil {
		return listenSpec{}, fmt.Errorf("%w: %q: %v", errBadListen, v, err)
	}
	if ip := net.ParseIP(strings.SplitN(host, "%", 2)[0]); ip == nil || !ip.IsLoopback() {
		return listenSpec{}, fmt.Errorf("%w: listen address %s is not loopback; use 127.0.0.1 or unix:///path.sock", errNotLoopback, v)
	}
	return listenSpec{addr: v}, nil
}

// bindUnix listens on a unix socket at path, mode 0600. A socket file with nothing behind it is replaced;
// a live one is errSocketLive. Anything else at the path is left alone and reported.
func bindUnix(path string) (*net.UnixListener, error) {
	if len(path) > maxUnixPath {
		return nil, fmt.Errorf("%w: %s", errUnixPathLength, path)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return nil, fmt.Errorf("%w: %s", errSocketLive, path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// bindAdmin makes the admin socket: its parent directory must belong to us and not be writable by group or
// others (else someone could swap the socket), and a live socket at the path is refused. The peer uid check
// on each connection is in peerCheckListener.
func bindAdmin(path string) (net.Listener, error) {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, fmt.Errorf("%w: %v", errAdminInsecure, err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errAdminInsecure, err)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Getuid() {
		return nil, fmt.Errorf("%w: directory %s is not owned by the user running convoz", errAdminInsecure, parent)
	}
	if mode := info.Mode().Perm(); mode&0o022 != 0 {
		return nil, fmt.Errorf("%w: directory %s has mode %04o and must not be writable by group or others", errAdminInsecure, parent, mode)
	}
	ln, err := bindUnix(path)
	if errors.Is(err, errSocketLive) || errors.Is(err, errUnixPathLength) {
		return nil, fmt.Errorf("%w: %v", errAdminInsecure, err)
	}
	if err != nil {
		return nil, err
	}
	return peerCheckListener{ln}, nil
}

// peerCheckListener drops any connection whose peer uid is not ours (SO_PEERCRED).
type peerCheckListener struct{ *net.UnixListener }

// Accept implements net.Listener.
func (l peerCheckListener) Accept() (net.Conn, error) {
	for {
		c, err := l.UnixListener.AcceptUnix()
		if err != nil {
			return nil, err
		}
		if uid, known := peerUID(c); known && int(uid) != os.Getuid() {
			c.Close()
			continue
		}
		return c, nil
	}
}
