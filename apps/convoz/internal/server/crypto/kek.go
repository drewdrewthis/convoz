// Package crypto holds the key material rules: the KEK file and the wrapped-DEK keyring (design §6.2).
package crypto

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// KEKSize is the KEK length in bytes.
const KEKSize = 32

// ErrKey marks every failure that must exit with code 10.
var ErrKey = errors.New("key")

// ResolveKEKPath returns the explicit path, else $CREDENTIALS_DIRECTORY/convoz-kek.
func ResolveKEKPath(flag, credentialsDir string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	if credentialsDir != "" {
		return filepath.Join(credentialsDir, "convoz-kek"), nil
	}
	return "", fmt.Errorf("%w: no KEK credential: set --kek-file or CREDENTIALS_DIRECTORY/convoz-kek", ErrKey)
}

// LoadKEK reads a KEK file: 32 raw bytes or base64 of 32 bytes. It refuses a file
// that group or others can access, because the KEK protects every other key.
func LoadKEK(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot read KEK file %s: %v", ErrKey, path, err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return nil, fmt.Errorf("%w: KEK file %s has mode %04o, needs 0600", ErrKey, path, mode)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot read KEK file %s: %v", ErrKey, path, err)
	}
	if dec, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(raw))); err == nil && len(dec) == KEKSize {
		return dec, nil
	}
	if len(raw) == KEKSize {
		return raw, nil
	}
	return nil, fmt.Errorf("%w: KEK file %s must hold 32 raw bytes or base64 of 32 bytes", ErrKey, path)
}
