package ops

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/age"
)

// The four key files `convoz backup keygen` writes (design §6.2; in production they sit in /etc/convoz/backup/).
// The service reads the recipient and the signing key; the identity and the verify key are for restore, and the
// owner keeps them off the server. The age files use age's own text formats; the ed25519 files are base64.
const (
	IdentityFile  = "backup-identity.key"
	RecipientFile = "backup-recipient.pub"
	SigningFile   = "backup-signing.key"
	VerifyFile    = "backup-verify.pub"
)

// GenerateBackupKeys writes a new age X25519 identity and recipient and a new ed25519 signing and verify key into dir.
// It never replaces a file.
func GenerateBackupKeys(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	id, err := age.GenerateX25519Identity()
	if err != nil {
		return err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	b64 := base64.StdEncoding.EncodeToString
	for _, f := range []struct {
		name string
		text string
		mode os.FileMode
	}{
		{IdentityFile, id.String(), 0o600},
		{RecipientFile, id.Recipient().String(), 0o644},
		{SigningFile, b64(priv.Seed()), 0o600},
		{VerifyFile, b64(pub), 0o644},
	} {
		if err := writeNew(filepath.Join(dir, f.name), f.text, f.mode); err != nil {
			return err
		}
	}
	return nil
}

func writeNew(path, text string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(text + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// readKey reads a base64 key file of exactly size bytes.
func readKey(path string, size int) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) != size {
		return nil, fmt.Errorf("%s must hold base64 of %d bytes", path, size)
	}
	return key, nil
}
