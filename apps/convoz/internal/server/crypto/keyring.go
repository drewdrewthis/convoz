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
	"strings"
	"syscall"
	"time"
)

// PurposeDB is the purpose of the DEK that keys the SQLite file.
const PurposeDB = "db"

// PurposeMachineKey is the purpose of the DEK that seals the recoverable copy of each machine key (I-25).
const PurposeMachineKey = "machine_key"

// purposes are the DEKs every keyring holds. A keyring written by an older build lacks the newer ones;
// OpenKeyring adds them.
var purposes = []string{PurposeDB, PurposeMachineKey}

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

// tempPrefix names the temp files publishNew writes; a crash can leave one behind.
const tempPrefix = ".keyring-"

// staleTempAge is how old a leftover temp file must be before OpenKeyring deletes it.
const staleTempAge = time.Hour

// OpenKeyring loads <dataDir>/keyring.json, or creates it with a fresh DB DEK. It
// refuses to create one when dbPath already exists: a new DEK could never open that
// file, and the old keyring is lost. Leftover temp files older than an hour are
// deleted first. Every failure here is ErrKey (exit 10).
func OpenKeyring(dataDir string, kek []byte, dbPath string, now time.Time) (*Keyring, error) {
	sweepTemps(dataDir, now.Add(-staleTempAge))
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
	doc, ring, g, err := unwrapKeyring(path, raw, kek)
	if err != nil {
		return nil, err
	}
	if err := ring.addMissing(doc, g, dataDir, path); err != nil {
		return nil, keyErr("cannot update %s: %v", path, err)
	}
	return ring, nil
}

// unwrapKeyring parses a keyring file and unwraps every DEK in it under kek. Every failure is ErrKey.
func unwrapKeyring(path string, raw, kek []byte) (*keyringDoc, *Keyring, cipher.AEAD, error) {
	var doc keyringDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, nil, nil, keyErr("%s is not valid: %v", path, err)
	}
	if doc.Version != keyringVersion {
		return nil, nil, nil, keyErr("%s has version %d, this build reads version %d", path, doc.Version, keyringVersion)
	}
	if doc.KEKID != kekID(kek) {
		return nil, nil, nil, keyErr("%s was written under a different KEK", path)
	}
	g, err := aead(kek)
	if err != nil {
		return nil, nil, nil, err
	}
	ring := &Keyring{deks: map[string][]byte{}}
	for _, d := range doc.DEKs {
		blob, err := base64.StdEncoding.DecodeString(d.Wrapped)
		if err != nil || len(blob) < g.NonceSize() {
			return nil, nil, nil, keyErr("%s has a malformed key %s", path, d.DEKID)
		}
		key, err := g.Open(nil, blob[:g.NonceSize()], blob[g.NonceSize():], aad(d.DEKID, d.Purpose))
		if err != nil {
			return nil, nil, nil, keyErr("cannot unwrap key %s in %s", d.DEKID, path)
		}
		ring.deks[d.Purpose] = key
	}
	if _, ok := ring.deks[PurposeDB]; !ok {
		return nil, nil, nil, keyErr("%s has no %s key", path, PurposeDB)
	}
	return &doc, ring, g, nil
}

// addMissing gives the keyring a DEK for every purpose it lacks and, if it added any, replaces the file
// atomically: a crash leaves either the old keyring or the new one, never a short file.
func (k *Keyring) addMissing(doc *keyringDoc, g cipher.AEAD, dataDir, path string) error {
	changed := false
	for _, purpose := range purposes {
		if _, ok := k.deks[purpose]; ok {
			continue
		}
		w, dek, err := newWrappedDEK(g, purpose)
		if err != nil {
			return err
		}
		doc.DEKs = append(doc.DEKs, w)
		k.deks[purpose] = dek
		changed = true
	}
	if !changed {
		return nil
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return replaceFile(dataDir, path, out)
}

// newWrappedDEK makes a fresh random DEK for purpose and its wrapped form.
func newWrappedDEK(g cipher.AEAD, purpose string) (wrappedDEK, []byte, error) {
	dek := make([]byte, 32)
	id := make([]byte, 8)
	nonce := make([]byte, g.NonceSize())
	for _, b := range [][]byte{dek, id, nonce} {
		if _, err := rand.Read(b); err != nil {
			return wrappedDEK{}, nil, err
		}
	}
	dekID := hex.EncodeToString(id)
	wrapped := g.Seal(nonce, nonce, dek, aad(dekID, purpose))
	return wrappedDEK{DEKID: dekID, Purpose: purpose, Wrapped: base64.StdEncoding.EncodeToString(wrapped)}, dek, nil
}

// replaceFile writes data to a temp file in dir, syncs it, renames it over path and syncs the directory.
func replaceFile(dir, path string, data []byte) error {
	tmp, err := os.CreateTemp(dir, tempPrefix+"*") // mode 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDir(dir)
}

// createKeyring publishes the new keyring without ever replacing an existing one, and syncs
// the file and its directory, so a crash cannot leave a database whose key was never stored.
func createKeyring(dataDir, path string, kek []byte) (*Keyring, error) {
	g, err := aead(kek)
	if err != nil {
		return nil, err
	}
	doc := keyringDoc{Version: keyringVersion, KEKID: kekID(kek)}
	ring := &Keyring{deks: map[string][]byte{}}
	for _, purpose := range purposes {
		w, dek, err := newWrappedDEK(g, purpose)
		if err != nil {
			return nil, err
		}
		doc.DEKs = append(doc.DEKs, w)
		ring.deks[purpose] = dek
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := publishNew(dataDir, path, out); err != nil {
		return nil, keyErr("cannot create %s: %v", path, err)
	}
	return ring, nil
}

// Seams for the tests: a file system without hard links is not available in CI.
var (
	linkFile   = os.Link
	renameFile = renameNoReplace
)

// publishNew writes data to a temp file in dir, syncs it, then link(2)s it to path: link
// fails if path exists (O_EXCL semantics), and path never shows a half-written file.
// A file system that refuses hard links (EPERM, ENOTSUP, EXDEV) falls back to
// renameat2(RENAME_NOREPLACE), which has the same two properties; a kernel or file
// system without that falls back to an O_EXCL create (never replaces, but a crash
// during the write can leave a short file, which OpenKeyring then rejects as invalid).
func publishNew(dir, path string, data []byte) error {
	tmp, err := os.CreateTemp(dir, tempPrefix+"*") // mode 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // the published name, not the temp name, is the keyring
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	err = linkFile(tmp.Name(), path)
	if isLinkUnsupported(err) {
		err = renameFile(tmp.Name(), path)
		if isRenameUnsupported(err) {
			err = createExclusive(path, data)
		}
	}
	if err != nil {
		return err
	}
	return syncDir(dir)
}

func isLinkUnsupported(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EXDEV)
}

func isRenameUnsupported(err error) bool {
	return errors.Is(err, syscall.ENOSYS) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP)
}

// createExclusive is the last resort: O_EXCL create, write, fsync.
func createExclusive(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// sweepTemps deletes temp files older than cutoff. Errors are ignored: a leftover file is
// harmless, and a failed sweep must not stop the server from starting.
func sweepTemps(dir string, cutoff time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), tempPrefix) || e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
