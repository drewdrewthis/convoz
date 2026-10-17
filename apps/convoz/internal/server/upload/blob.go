package upload

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

const (
	nonceSize = 12
	tagSize   = 16
	// overhead is what sealing adds to a segment: its random nonce and the GCM tag.
	overhead = nonceSize + tagSize
)

// Blobs is the directory of sealed files and the key that wraps their file keys.
type Blobs struct {
	dir string
	dek []byte
}

// NewBlobs prepares <dataDir>/blobs (mode 0700). dek is the keyring's blob DEK.
func NewBlobs(dataDir string, dek []byte) (*Blobs, error) {
	if len(dek) != 32 {
		return nil, errors.New("the blob key must be 32 bytes")
	}
	dir := filepath.Join(dataDir, "blobs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Blobs{dir: dir, dek: dek}, nil
}

// Dir is where the sealed files live.
func (b *Blobs) Dir() string { return b.dir }

func (b *Blobs) path(storage string) string { return filepath.Join(b.dir, storage) }

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func wrapAAD(publicID string) []byte { return []byte("convoz-blob-key-v1\x00" + publicID) }

// newFileKey makes the random key of one file and its wrapped form for the row.
func (b *Blobs) newFileKey(publicID string) (key, wrapped []byte, err error) {
	key = make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, nil, err
	}
	g, err := gcm(b.dek)
	if err != nil {
		return nil, nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return key, g.Seal(nonce, nonce, key, wrapAAD(publicID)), nil
}

// unwrap opens a file key. A key wrapped for another upload id does not open.
func (b *Blobs) unwrap(publicID string, wrapped []byte) ([]byte, error) {
	g, err := gcm(b.dek)
	if err != nil {
		return nil, err
	}
	if len(wrapped) < nonceSize {
		return nil, ErrCorrupt
	}
	key, err := g.Open(nil, wrapped[:nonceSize], wrapped[nonceSize:], wrapAAD(publicID))
	if err != nil {
		return nil, ErrCorrupt
	}
	return key, nil
}

// segmentAAD binds a segment to its file, its place and whether it ends the file: moved, reordered or cut-off segments fail to open.
func segmentAAD(publicID string, index uint64, final bool) []byte {
	out := append([]byte(publicID), 0)
	out = binary.BigEndian.AppendUint64(out, index)
	if final {
		return append(out, 1)
	}
	return append(out, 0)
}

// sealSegment appends one sealed segment (nonce ‖ ciphertext ‖ tag) to the file.
func (b *Blobs) sealSegment(storage string, key []byte, publicID string, index uint64, plain []byte, final bool) error {
	g, err := gcm(key)
	if err != nil {
		return err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil { // random, so a re-sealed segment after a crash never reuses one
		return err
	}
	sealed := g.Seal(nonce, nonce, plain, segmentAAD(publicID, index, final))
	f, err := os.OpenFile(b.path(storage), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(sealed); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// truncateTo cuts the file to the whole segments the database counts, dropping what a crash left after them.
func (b *Blobs) truncateTo(storage string, segments uint64) error {
	want := int64(segments) * (SegmentSize + overhead)
	err := os.Truncate(b.path(storage), want)
	if errors.Is(err, fs.ErrNotExist) && segments == 0 {
		return nil
	}
	return err
}

// Remove unlinks sealed files; one that is already gone is no error.
func (b *Blobs) Remove(storages ...string) {
	for _, s := range storages {
		_ = os.Remove(b.path(s))
	}
}

// Sweep unlinks files in the directory that no row names and that are older than an hour (a crash between the two steps of a delete).
func (b *Blobs) Sweep(known map[string]bool, olderThan func(info fs.FileInfo) bool) {
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || known[e.Name()] {
			continue
		}
		if info, err := e.Info(); err == nil && olderThan(info) {
			_ = os.Remove(filepath.Join(b.dir, e.Name()))
		}
	}
}

// Reader is a sealed file opened for reading: it decrypts a segment at a time and seeks, so a range request costs one segment.
type Reader struct {
	f        *os.File
	g        cipher.AEAD
	publicID string
	size     int64
	pos      int64
	index    int64 // the segment in cur, -1 for none
	cur      []byte
}

// Open opens a complete file of the given plaintext size. It checks the length of the stored file against the size first.
func (b *Blobs) Open(r Row) (*Reader, error) {
	key, err := b.unwrap(r.PublicID, r.KeyWrapped)
	if err != nil {
		return nil, err
	}
	return b.openWith(r.StorageName, key, r.PublicID, r.DeclaredSize)
}

func (b *Blobs) openWith(storage string, key []byte, publicID string, size int64) (*Reader, error) {
	g, err := gcm(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(b.path(storage))
	if err != nil {
		return nil, ErrCorrupt
	}
	info, err := f.Stat()
	if err != nil || info.Size() != storedSize(size) {
		f.Close()
		return nil, ErrCorrupt
	}
	return &Reader{f: f, g: g, publicID: publicID, size: size, index: -1}, nil
}

// storedSize is the length of a file of the given plaintext size once sealed.
func storedSize(size int64) int64 {
	segments := (size + SegmentSize - 1) / SegmentSize
	return size + segments*overhead
}

// Size is the plaintext length.
func (r *Reader) Size() int64 { return r.size }

// Close closes the file.
func (r *Reader) Close() error { return r.f.Close() }

// load decrypts segment i into r.cur.
func (r *Reader) load(i int64) error {
	if r.index == i {
		return nil
	}
	last := (r.size - 1) / SegmentSize
	plain := min(int64(SegmentSize), r.size-i*SegmentSize)
	buf := make([]byte, plain+overhead)
	if _, err := r.f.ReadAt(buf, i*(SegmentSize+overhead)); err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	out, err := r.g.Open(nil, buf[:nonceSize], buf[nonceSize:], segmentAAD(r.publicID, uint64(i), i == last))
	if err != nil {
		return ErrCorrupt
	}
	r.cur, r.index = out, i
	return nil
}

// Verify opens the first and the last segment, so a file moved to another id or cut short is found before a byte is sent.
func (r *Reader) Verify() error {
	if err := r.load((r.size - 1) / SegmentSize); err != nil {
		return err
	}
	return r.load(0)
}

// Read implements io.Reader.
func (r *Reader) Read(p []byte) (int, error) {
	if r.pos >= r.size {
		return 0, io.EOF
	}
	if err := r.load(r.pos / SegmentSize); err != nil {
		return 0, err
	}
	n := copy(p, r.cur[r.pos%SegmentSize:])
	r.pos += int64(n)
	return n, nil
}

// Seek implements io.Seeker.
func (r *Reader) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = r.pos + offset
	case io.SeekEnd:
		abs = r.size + offset
	default:
		return 0, errors.New("bad whence")
	}
	if abs < 0 {
		return 0, errors.New("negative position")
	}
	r.pos = abs
	return abs, nil
}
