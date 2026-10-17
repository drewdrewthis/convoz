package ops

import (
	"archive/tar"
	"context"
	stdcrypto "crypto"
	"crypto/ed25519"
	"crypto/sha512"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

const (
	magic    = "CONVOZ-BACKUP-1\n"
	sigSize  = ed25519.SignatureSize
	bodyFrom = int64(len(magic) + sigSize)

	// Names inside the archive: the encrypted database snapshot, the wrapped keyring and the blob tree.
	dbName    = "convoz.db"
	blobsName = "blobs"
)

var sigOptions = &ed25519.Options{Hash: stdcrypto.SHA512}

// BackupParams says what to back up and with which keys.
type BackupParams struct {
	DataDir    string
	KEK        []byte
	Recipient  string // path of the age X25519 recipient (public) file
	SigningKey string // path of the ed25519 signing key file
	Out        string // the backup file to create; it must not exist
}

// Backup snapshots the database through the encrypted VFS (the live server may keep writing), tars the snapshot with
// keyring.json and blobs/, encrypts the tar to the recipient and signs the result (design §14). The database
// stays encrypted at every step, and the keyring in the archive is still wrapped under the KEK.
func Backup(ctx context.Context, p BackupParams) (err error) {
	seed, err := readKey(p.SigningKey, ed25519.SeedSize)
	if err != nil {
		return err
	}
	ring, err := crypto.LoadKeyring(p.DataDir, p.KEK)
	if err != nil {
		return err
	}
	dek, ok := ring.DEK(crypto.PurposeDB)
	if !ok {
		return errors.New("keyring has no database key")
	}
	stage, err := os.MkdirTemp(filepath.Dir(p.Out), ".convoz-backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := snapshot(ctx, filepath.Join(p.DataDir, dbName), dek, filepath.Join(stage, dbName)); err != nil {
		return err
	}
	partial := p.Out + ".partial"
	out, err := os.OpenFile(partial, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		out.Close()
		if err != nil {
			os.Remove(partial)
		}
	}()
	if _, err = out.Write(append([]byte(magic), make([]byte, sigSize)...)); err != nil { // the signature goes in last
		return err
	}
	digest := sha512.New()
	digest.Write([]byte(magic))
	sealer, err := newSealWriter(io.MultiWriter(out, digest), p.Recipient)
	if err != nil {
		return err
	}
	if err = writeArchive(sealer, p.DataDir, stage); err != nil {
		return err
	}
	if err = sealer.Close(); err != nil {
		return err
	}
	sig, err := ed25519.NewKeyFromSeed(seed).Sign(nil, digest.Sum(nil), sigOptions)
	if err != nil {
		return err
	}
	if _, err = out.WriteAt(sig, int64(len(magic))); err != nil {
		return err
	}
	if err = out.Sync(); err != nil {
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	return os.Rename(partial, p.Out)
}

// snapshot copies the live database into dst with SQLite's online backup, under the same key.
func snapshot(ctx context.Context, src string, dek []byte, dst string) error {
	store, err := db.Open(src, dek)
	if err != nil {
		return err
	}
	defer store.Close()
	return store.Writer.Backup(ctx, dst)
}

// writeArchive tars the snapshot, the keyring and the blob tree. Only regular files go in.
func writeArchive(w io.Writer, dataDir, stage string) error {
	tw := tar.NewWriter(w)
	if err := addFile(tw, dbName, filepath.Join(stage, dbName)); err != nil {
		return err
	}
	if err := addFile(tw, crypto.KeyringFile, filepath.Join(dataDir, crypto.KeyringFile)); err != nil {
		return err
	}
	blobs := filepath.Join(dataDir, blobsName)
	err := filepath.WalkDir(blobs, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		rel, rerr := filepath.Rel(dataDir, path)
		if rerr != nil {
			return rerr
		}
		return addFile(tw, filepath.ToSlash(rel), path)
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return tw.Close()
}

func addFile(tw *tar.Writer, name, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: info.Size(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := io.Copy(tw, f); err != nil {
		return fmt.Errorf("add %s: %w", name, err)
	}
	return nil
}
