package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// PurposeDB is the purpose of the DEK that keys the SQLite file.
const PurposeDB = "db"

// KeyringFile is the keyring's file name inside the data dir.
const KeyringFile = "keyring.json"

type wrappedDEK struct {
	DEKID   string `json:"dek_id"`
	Purpose string `json:"purpose"`
	Wrapped string `json:"wrapped"`
}

type keyringDoc struct {
	Version int          `json:"version"`
	KEKID   string       `json:"kek_id"`
	DEKs    []wrappedDEK `json:"deks"`
}

// Keyring is the set of DEKs, unwrapped in memory.
type Keyring struct {
	deks map[string][]byte // purpose -> key
}

// DEK returns the key for a purpose.
func (k *Keyring) DEK(purpose string) ([]byte, bool) {
	d, ok := k.deks[purpose]
	return d, ok
}

// kekID names a KEK without revealing it.
func kekID(kek []byte) string {
	sum := sha256.Sum256(append([]byte("convoz-kek-id-v1"), kek...))
	return hex.EncodeToString(sum[:8])
}

func aead(kek []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// aad binds a wrapped key to its id and purpose so it cannot be moved to another slot.
// The id is length-prefixed, so ("ab","c") and ("a","bc") never share an AAD.
func aad(dekID, purpose string) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(dekID)))
	return append(append(out, dekID...), purpose...)
}

// keyringVersion is the only keyring format this build reads or writes.
const keyringVersion = 1

// OpenKeyring loads <dataDir>/keyring.json, or creates it with a fresh DB DEK. It
// refuses to create one when dbPath already exists: a new DEK could never open that
// file, and the old keyring is lost. Every failure here is ErrKey (exit 10).
func OpenKeyring(dataDir string, kek []byte, dbPath string) (*Keyring, error) {
	path := filepath.Join(dataDir, KeyringFile)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Stat(dbPath); statErr == nil {
			return nil, keyErr("%s exists but %s is missing; restore the keyring (a backup keeps a copy next to each .db), a new one cannot open this database", dbPath, path)
		}
		return createKeyring(dataDir, path, kek)
	}
	if err != nil {
		return nil, keyErr("cannot read %s: %v", path, err)
	}
	var doc keyringDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, keyErr("%s is not valid: %v", path, err)
	}
	if doc.Version != keyringVersion {
		return nil, keyErr("%s has version %d, this build reads version %d", path, doc.Version, keyringVersion)
	}
	if doc.KEKID != kekID(kek) {
		return nil, keyErr("%s was written under a different KEK", path)
	}
	g, err := aead(kek)
	if err != nil {
		return nil, err
	}
	ring := &Keyring{deks: map[string][]byte{}}
	for _, d := range doc.DEKs {
		blob, err := base64.StdEncoding.DecodeString(d.Wrapped)
		if err != nil || len(blob) < g.NonceSize() {
			return nil, keyErr("%s has a malformed key %s", path, d.DEKID)
		}
		key, err := g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], aad(d.DEKID, d.Purpose))
		if err != nil {
			return nil, keyErr("cannot unwrap key %s in %s", d.DEKID, path)
		}
		ring.deks[d.Purpose] = key
	}
	if _, ok := ring.deks[PurposeDB]; !ok {
		return nil, keyErr("%s has no %s key", path, PurposeDB)
	}
	return ring, nil
}

// createKeyring writes the new keyring with O_EXCL (never over an existing one) and syncs
// the file and its directory, so a crash cannot leave a database whose key was never stored.
func createKeyring(dataDir, path string, kek []byte) (*Keyring, error) {
	g, err := aead(kek)
	if err != nil {
		return nil, err
	}
	dek := make([]byte, 32)
	id := make([]byte, 8)
	nonce := make([]byte, g.NonceSize())
	for _, b := range [][]byte{dek, id, nonce} {
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
	}
	dekID := hex.EncodeToString(id)
	wrapped := g.Seal(nonce, nonce, dek, aad(dekID, PurposeDB))
	doc := keyringDoc{Version: keyringVersion, KEKID: kekID(kek), DEKs: []wrappedDEK{{
		DEKID: dekID, Purpose: PurposeDB, Wrapped: base64.StdEncoding.EncodeToString(wrapped),
	}}}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, keyErr("cannot create %s: %v", path, err)
	}
	if _, err := f.Write(out); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := syncDir(dataDir); err != nil {
		return nil, err
	}
	return &Keyring{deks: map[string][]byte{PurposeDB: dek}}, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
