package crypto

import (
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// LoadKeyring unwraps <dataDir>/keyring.json under kek without creating or changing anything.
// Every failure is ErrKey.
func LoadKeyring(dataDir string, kek []byte) (*Keyring, error) {
	path := filepath.Join(dataDir, KeyringFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, keyErr("cannot read %s: %v", path, err)
	}
	_, ring, _, err := unwrapKeyring(path, raw, kek)
	return ring, err
}

// RotateKEK rewraps every DEK of the keyring under newKEK and replaces the file atomically
// (design §6.2). The DEKs do not change, so the database and the blobs stay as they are. The old KEK
// still opens every backup made before the rotation, so the owner keeps its file until they expire.
func RotateKEK(dataDir string, oldKEK, newKEK []byte) error {
	path := filepath.Join(dataDir, KeyringFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return keyErr("cannot read %s: %v", path, err)
	}
	doc, ring, _, err := unwrapKeyring(path, raw, oldKEK)
	if err != nil {
		return err
	}
	g, err := aead(newKEK)
	if err != nil {
		return err
	}
	out := keyringDoc{Version: keyringVersion, KEKID: kekID(newKEK)}
	for _, d := range doc.DEKs {
		w, err := rewrap(g, d, ring.deks[d.Purpose])
		if err != nil {
			return err
		}
		out.DEKs = append(out.DEKs, w)
	}
	enc, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	if err := replaceFile(dataDir, path, enc); err != nil {
		return keyErr("cannot replace %s: %v", path, err)
	}
	return nil
}

// rewrap seals dek under g with a fresh nonce, keeping the DEK's id and purpose (they are in the AAD).
func rewrap(g cipher.AEAD, d wrappedDEK, dek []byte) (wrappedDEK, error) {
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return wrappedDEK{}, err
	}
	sealed := g.Seal(nonce, nonce, dek, aad(d.DEKID, d.Purpose))
	return wrappedDEK{DEKID: d.DEKID, Purpose: d.Purpose, Wrapped: base64.StdEncoding.EncodeToString(sealed)}, nil
}

// NewKEKFile writes a fresh random KEK (base64, mode 0600) to path. It never replaces a file.
func NewKEKFile(path string) ([]byte, error) {
	kek := make([]byte, KEKSize)
	if _, err := rand.Read(kek); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, keyErr("cannot create KEK file %s: %v", path, err)
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(kek)); err != nil {
		f.Close()
		return nil, keyErr("cannot write KEK file %s: %v", path, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	return kek, f.Close()
}

// Shred overwrites a file with zeros, syncs it and removes it. A missing file is not an error.
// On a copy-on-write or journaling disk the overwrite cannot promise the old blocks are gone; the destroy
// command says so, because the KEK in other places (the systemd credential, backups of it) is the owner's to remove.
func Shred(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err == nil {
		_, err = f.Write(make([]byte, info.Size()))
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Remove(path)
}

// DestroyKeys shreds the keyring in dataDir (and the copies the pre-migration backups keep) and the KEK file: the crypto-shred of design §14. The caller has
// already proved it holds the KEK. The keyring goes first, so a failure half way leaves a KEK that opens nothing.
func DestroyKeys(dataDir, kekPath string) error {
	copies, err := filepath.Glob(filepath.Join(dataDir, "backups", "*.keyring.json")) // the pre-migration copies
	if err != nil {
		return err
	}
	for _, path := range append(copies, filepath.Join(dataDir, KeyringFile)) {
		if err := Shred(path); err != nil {
			return err
		}
	}
	return Shred(kekPath)
}
