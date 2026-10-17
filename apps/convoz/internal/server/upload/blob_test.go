package upload

import (
	"bytes"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func testBlobs(t *testing.T) *Blobs {
	t.Helper()
	b, err := NewBlobs(t.TempDir(), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// seal writes data as a file of segments, the way Receive does, and returns what a Row needs to open it.
func seal(t *testing.T, b *Blobs, pub, storage string, data []byte) Row {
	t.Helper()
	key, wrapped, err := b.newFileKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		rest := data[i*SegmentSize:]
		final := len(rest) <= SegmentSize
		if !final {
			rest = rest[:SegmentSize]
		}
		if err := b.sealSegment(storage, key, pub, uint64(i), rest, final); err != nil {
			t.Fatal(err)
		}
		if final {
			break
		}
	}
	return Row{PublicID: pub, StorageName: storage, KeyWrapped: wrapped, DeclaredSize: int64(len(data)), State: "complete"}
}

func TestABlobRoundTripsAcrossSegmentsAndSeeks(t *testing.T) {
	b := testBlobs(t)
	data := make([]byte, 2*SegmentSize+123)
	_, _ = rand.Read(data)
	row := seal(t, b, "pub-aaaaaaaaaaaaaaaaaaaaa", "f1", data)
	rd, err := b.Open(row)
	if err != nil {
		t.Fatal(err)
	}
	defer rd.Close()
	if err := rd.Verify(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rd)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("round trip: %v, equal %v", err, bytes.Equal(got, data))
	}
	if _, err := rd.Seek(SegmentSize+5, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	part := make([]byte, 100)
	if _, err := io.ReadFull(rd, part); err != nil || !bytes.Equal(part, data[SegmentSize+5:SegmentSize+105]) {
		t.Fatalf("a range after a seek: %v", err)
	}
}

func TestNoPlaintextReachesTheDisk(t *testing.T) {
	b := testBlobs(t)
	marker := bytes.Repeat([]byte("ZQX-PLAINTEXT-MARKER-"), 40)
	seal(t, b, "pub-bbbbbbbbbbbbbbbbbbbbb", "f2", marker)
	raw, err := os.ReadFile(filepath.Join(b.Dir(), "f2"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("ZQX-PLAINTEXT")) {
		t.Fatal("the sealed file holds plaintext")
	}
}

func TestABlobMovedToAnotherFileIDCannotBeRead(t *testing.T) {
	b := testBlobs(t)
	a := seal(t, b, "pub-cccccccccccccccccccccc"[:22], "fa", bytes.Repeat([]byte("a"), 1000))
	c := seal(t, b, "pub-dddddddddddddddddddddd"[:22], "fc", bytes.Repeat([]byte("c"), 1000))
	if err := os.Rename(filepath.Join(b.Dir(), "fa"), filepath.Join(b.Dir(), "tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(b.Dir(), "fc"), filepath.Join(b.Dir(), "fa")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(b.Dir(), "tmp"), filepath.Join(b.Dir(), "fc")); err != nil {
		t.Fatal(err)
	}
	for _, row := range []Row{a, c} {
		rd, err := b.Open(row)
		if err == nil {
			err = rd.Verify()
			rd.Close()
		}
		if err == nil {
			t.Fatalf("upload %s opened a blob that was moved", row.PublicID)
		}
	}
}

func TestACutOffBlobDoesNotOpen(t *testing.T) {
	b := testBlobs(t)
	row := seal(t, b, "pub-eeeeeeeeeeeeeeeeeeeeee"[:22], "fe", make([]byte, SegmentSize+10))
	if err := os.Truncate(filepath.Join(b.Dir(), "fe"), SegmentSize+overhead); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Open(row); err == nil {
		t.Fatal("a file cut after its first segment opened")
	}
}
