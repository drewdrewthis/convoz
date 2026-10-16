// Package crypto holds the key material rules: the KEK file and the wrapped-DEK keyring (design §6.2).
package crypto

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// KEKSize is the KEK length in bytes.
const KEKSize = 32

// ErrKey marks every failure that must exit with code 10 (errors.Is).
var ErrKey = errors.New("key")

// keyError matches ErrKey but prints only its message, so no "key: " prefix leaks into output.
type keyError struct{ msg string }

func (e *keyError) Error() string        { return e.msg }
func (e *keyError) Is(target error) bool { return target == ErrKey }

func keyErr(format string, args ...any) error { return &keyError{fmt.Sprintf(format, args...)} }

// ResolveKEKPath returns the explicit path, else $CREDENTIALS_DIRECTORY/convoz-kek.
func ResolveKEKPath(flag, credentialsDir string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	if credentialsDir != "" {
		return filepath.Join(credentialsDir, "convoz-kek"), nil
	}
	return "", keyErr("no KEK credential: set --kek-file or CREDENTIALS_DIRECTORY/convoz-kek")
}

// maxKEKFile bounds the read: a KEK file is 32 raw bytes or 44 base64 characters.
const maxKEKFile = 1024

// LoadKEK reads a KEK file: 32 raw bytes or base64 of 32 bytes. The file must be a regular
// file owned by the current user with mode 0600 or 0400, because the KEK protects every
// other key. It opens first and checks the open handle, so the file cannot change between
// the check and the read.
func LoadKEK(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, keyErr("cannot read KEK file %s: %v", path, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, keyErr("cannot read KEK file %s: %v", path, err)
	}
	if !info.Mode().IsRegular() {
		return nil, keyErr("KEK file %s is not a regular file", path)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Getuid() {
		return nil, keyErr("KEK file %s must be owned by the user running convoz", path)
	}
	if mode := info.Mode().Perm(); mode != 0o600 && mode != 0o400 {
		return nil, keyErr("KEK file %s has mode %04o, needs 0600", path, mode)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxKEKFile))
	if err != nil {
		return nil, keyErr("cannot read KEK file %s: %v", path, err)
	}
	if dec, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(raw))); err == nil && len(dec) == KEKSize {
		return dec, nil
	}
	if len(raw) == KEKSize {
		return raw, nil
	}
	return nil, keyErr("KEK file %s must hold 32 raw bytes or base64 of 32 bytes", path)
}
