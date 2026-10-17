package ops

import (
	"archive/tar"
	"crypto/ed25519"
	"crypto/sha512"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// RestoreParams says which backup to open, with which keys, and where the data dir goes.
type RestoreParams struct {
	Backup    string
	Into      string // the new data dir: it must not exist, or be empty
	KEK       []byte // the KEK that wrapped the keyring when the backup was made (an old one after a rotation)
	Identity  string // path of the age X25519 identity (private) file
	VerifyKey string // path of the ed25519 verify key file
}

// keyFailure is a restore stop that belongs to the key (exit 10), printed as is.
type keyFailure string

func (e keyFailure) Error() string        { return string(e) }
func (e keyFailure) Is(target error) bool { return target == crypto.ErrKey }

// Restore checks the signature, decrypts, checks the keyring opens under the KEK and the database opens under the
// keyring, and only then moves the result to p.Into. Any failure leaves p.Into as it was (design §14).
func Restore(p RestoreParams) error {
	if err := checkTarget(p.Into); err != nil {
		return err
	}
	verify, err := readKey(p.VerifyKey, ed25519.PublicKeySize)
	if err != nil {
		return err
	}
	in, err := os.Open(p.Backup)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := verifySignature(in, verify); err != nil {
		return err
	}
	if _, err := in.Seek(bodyFrom, io.SeekStart); err != nil {
		return err
	}
	plain, err := openReader(in, p.Identity)
	if err != nil {
		return err
	}
	parent := filepath.Dir(p.Into)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".convoz-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage) // a no-op once the stage is renamed into place
	if err := extract(plain, stage); err != nil {
		return err
	}
	ring, err := crypto.LoadKeyring(stage, p.KEK)
	if err != nil {
		return keyFailure("cannot unwrap the keyring: the KEK does not match the one that wrapped this backup's keys")
	}
	dek, _ := ring.DEK(crypto.PurposeDB)
	store, err := db.Open(filepath.Join(stage, dbName), dek)
	if err != nil {
		return fmt.Errorf("the database in the backup does not open with its keyring: %w", err)
	}
	if err := store.Close(); err != nil {
		return err
	}
	if err := os.Remove(p.Into); err != nil && !errors.Is(err, os.ErrNotExist) { // an empty dir made by mktemp -d
		return err
	}
	return os.Rename(stage, p.Into)
}

// checkTarget refuses a data dir that already holds anything.
func checkTarget(dir string) error {
	entries, err := os.ReadDir(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil
	case err != nil:
		return err
	case len(entries) > 0:
		return fmt.Errorf("%s is not empty; restore into a new directory", dir)
	}
	return nil
}

// verifySignature checks the ed25519ph signature over the magic and the body. It reads the whole file.
func verifySignature(f *os.File, pub ed25519.PublicKey) error {
	head := make([]byte, len(magic)+sigSize)
	if _, err := io.ReadFull(f, head); err != nil || string(head[:len(magic)]) != magic {
		return errors.New("not a Convoz backup")
	}
	digest := sha512.New()
	digest.Write([]byte(magic))
	if _, err := io.Copy(digest, f); err != nil {
		return err
	}
	if err := ed25519.VerifyWithOptions(pub, digest.Sum(nil), head[len(magic):], sigOptions); err != nil {
		return errors.New("signature does not verify")
	}
	return nil
}

// extract unpacks the archive into dir. It accepts only the database, the keyring and files under blobs/.
func extract(r io.Reader, dir string) error {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return decryptOrDamaged(err)
		}
		name := path.Clean(h.Name)
		if h.Typeflag != tar.TypeReg || !allowed(name) {
			return fmt.Errorf("the backup holds an unexpected entry %q", h.Name)
		}
		dst := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, tr)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return decryptOrDamaged(err)
		}
	}
}

func allowed(name string) bool {
	if name == dbName || name == crypto.KeyringFile {
		return true
	}
	rest, ok := strings.CutPrefix(name, blobsName+"/")
	return ok && rest != "" && !strings.HasPrefix(rest, "../") && !path.IsAbs(rest)
}

func decryptOrDamaged(err error) error {
	if errors.Is(err, errDecrypt) {
		return errDecrypt
	}
	return fmt.Errorf("the backup is damaged: %w", err)
}
