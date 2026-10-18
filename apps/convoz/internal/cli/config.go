package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// IO is what a command talks to, so a test can give it files and an environment of its own.
type IO struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	Getenv func(string) string
}

// Modes of the config directory and the files in it. Anything looser is refused, not repaired: a
// machine key in a group-readable file may already have been read.
const (
	dirMode  os.FileMode = 0o700
	fileMode os.FileMode = 0o600
)

// permError names the path and the mode it needs.
type permError struct {
	path      string
	got, need os.FileMode
}

func (e *permError) Error() string {
	return fmt.Sprintf("%s has mode %04o and needs %04o (run: chmod %04o %s)", e.path, e.got, e.need, e.need, e.path)
}

// configDir is $XDG_CONFIG_HOME/convoz, else ~/.config/convoz on every OS (not os.UserConfigDir, so macOS
// matches the design).
func configDir(getenv func(string) string) (string, error) {
	if x := getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "convoz"), nil
	}
	home := getenv("HOME")
	if home == "" {
		return "", errors.New("HOME is not set, so there is no config directory")
	}
	return filepath.Join(home, ".config", "convoz"), nil
}

// checkMode fails with a *permError when path has any group or other permission bit.
func checkMode(path string, need os.FileMode) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if got := info.Mode().Perm(); got&0o077 != 0 {
		return &permError{path: path, got: got, need: need}
	}
	return nil
}

// privateDir makes the directory (mode 0700) if it is missing and checks the mode if it exists.
func privateDir(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return err
	}
	if err := os.Mkdir(path, dirMode); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return checkMode(path, dirMode)
}

// checkWritable proves the config directory can be made and a private file written in it, so a login fails before it asks the owner.
func checkWritable(dir string) error {
	if err := privateDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".probe-*") // 0600
	if err != nil {
		return err
	}
	tmp.Close()
	return os.Remove(tmp.Name())
}

// writePrivate writes data to path as a 0600 file: a temp file in the same directory, then a rename, so a
// reader never sees a half-written key.
func writePrivate(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*") // 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), fileMode); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// readPrivate reads a file after checking that it and its directory are private.
func readPrivate(dir, path string) ([]byte, error) {
	if err := checkMode(dir, dirMode); err != nil {
		return nil, err
	}
	if err := checkMode(path, fileMode); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}
