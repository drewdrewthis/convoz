package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
func aad(dekID, purpose string) []byte { return []byte(dekID + purpose) }

// OpenKeyring loads <dataDir>/keyring.json, or creates it with a fresh DB DEK.
// A keyring written under another KEK fails with ErrKey.
func OpenKeyring(dataDir string, kek []byte) (*Keyring, error) {
	path := filepath.Join(dataDir, KeyringFile)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return createKeyring(path, kek)
	}
	if err != nil {
		return nil, err
	}
	var doc keyringDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%w: %s is not valid: %v", ErrKey, path, err)
	}
	if doc.KEKID != kekID(kek) {
		return nil, fmt.Errorf("%w: %s was written under a different KEK", ErrKey, path)
	}
	g, err := aead(kek)
	if err != nil {
		return nil, err
	}
	ring := &Keyring{deks: map[string][]byte{}}
	for _, d := range doc.DEKs {
		blob, err := base64.StdEncoding.DecodeString(d.Wrapped)
		if err != nil || len(blob) < g.NonceSize() {
			return nil, fmt.Errorf("%w: %s has a malformed key %s", ErrKey, path, d.DEKID)
		}
		key, err := g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], aad(d.DEKID, d.Purpose))
		if err != nil {
			return nil, fmt.Errorf("%w: cannot unwrap key %s in %s", ErrKey, d.DEKID, path)
		}
		ring.deks[d.Purpose] = key
	}
	if _, ok := ring.deks[PurposeDB]; !ok {
		return nil, fmt.Errorf("%w: %s has no %s key", ErrKey, path, PurposeDB)
	}
	return ring, nil
}

func createKeyring(path string, kek []byte) (*Keyring, error) {
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
	doc := keyringDoc{Version: 1, KEKID: kekID(kek), DEKs: []wrappedDEK{{
		DEKID: dekID, Purpose: PurposeDB, Wrapped: base64.StdEncoding.EncodeToString(wrapped),
	}}}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return &Keyring{deks: map[string][]byte{PurposeDB: dek}}, nil
}
