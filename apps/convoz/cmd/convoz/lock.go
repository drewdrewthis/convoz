package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

var errInUse = errors.New("is in use by another process")

// lockDataDir creates the data dir (owner-only) and takes an exclusive, non-blocking
// flock on <dir>/convoz.lock. The lock lives as long as the returned file stays open,
// and the kernel drops it if the process dies, so there is no stale lock to clean up.
func lockDataDir(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil { // tighten a dir that already existed
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "convoz.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("data dir %s %w", dir, errInUse)
		}
		return nil, err
	}
	return f, nil
}
