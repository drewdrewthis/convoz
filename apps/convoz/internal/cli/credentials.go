package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Where the machine key lives (--store).
const (
	storeFile     = "file"
	storeKeychain = "keychain"
	storeAuto     = "auto" // the keychain if one answers, else the file
)

// credentialsFile is the file name inside the config directory.
const credentialsFile = "credentials"

// Credentials say which machine this is and where its server is. With the keychain store the key is not in
// the file.
type Credentials struct {
	Server  string `json:"server"`
	Machine string `json:"machine"`
	Store   string `json:"store"`
	Key     string `json:"key,omitempty"`
}

var machineKeyRE = regexp.MustCompile(`^cvz_m_[A-Za-z0-9]{10,}$`)

// saveCredentials stores the key where store says. "auto" falls back to the file when the keychain fails.
func saveCredentials(dir string, kc keychain, c Credentials, store string) error {
	if err := privateDir(dir); err != nil {
		return err
	}
	switch store {
	case storeKeychain, storeAuto:
		err := kc.Set(c.Server, c.Key)
		if err == nil {
			c.Store, c.Key = storeKeychain, ""
			break
		}
		if store == storeKeychain {
			return fmt.Errorf("cannot use the keychain: %w", err)
		}
		fallthrough
	default:
		c.Store = storeFile
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return writePrivate(filepath.Join(dir, credentialsFile), raw)
}

// loadCredentials reads the credentials after checking that the directory and the file are private.
func loadCredentials(dir string, kc keychain) (Credentials, error) {
	path := filepath.Join(dir, credentialsFile)
	raw, err := readPrivate(dir, path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Credentials{}, errNotLoggedIn
		}
		return Credentials{}, err
	}
	var c Credentials
	if err := json.Unmarshal(raw, &c); err != nil || c.Server == "" || c.Machine == "" {
		return Credentials{}, fmt.Errorf("%s is not a credentials file", path)
	}
	if c.Store == storeKeychain {
		if c.Key, err = kc.Get(c.Server); err != nil {
			return Credentials{}, fmt.Errorf("the key is in the OS keychain and it cannot be read: %w", err)
		}
	}
	if !machineKeyRE.MatchString(strings.TrimSpace(c.Key)) {
		return Credentials{}, fmt.Errorf("%s holds no machine key", path)
	}
	return c, nil
}
