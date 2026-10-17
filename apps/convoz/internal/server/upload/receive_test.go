package upload

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"testing"
)

// started makes the Row of an upload of known size whose key the service can open.
func started(t *testing.T, s *Service, data []byte, deferred bool) Row {
	t.Helper()
	pub := "ppppppppppppppppppppp1"
	_, wrapped, err := s.Blobs.newFileKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	r := Row{PublicID: pub, StorageName: "st-" + pub, Kind: KindFile, State: "receiving", DeclaredSize: int64(len(data)), SHA256: sum[:], KeyWrapped: wrapped, Filename: "x.bin"}
	if deferred {
		r.DeclaredSize, r.SHA256, r.Deferred = MaxSize, make([]byte, 32), true
	}
	return r
}

func TestAChunkedUploadCompletesAndReadsBack(t *testing.T) {
	s := NewService(testBlobs(t))
	data := make([]byte, SegmentSize+SegmentSize/2)
	_, _ = rand.Read(data)
	r := started(t, s, data, false)
	p, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data[:SegmentSize+10]))
	if err != nil || p.Finished != nil || p.Committed != SegmentSize || p.Offset != SegmentSize+10 {
		t.Fatalf("first chunk: %+v %v", p, err)
	}
	if got := s.Offset(r); got != SegmentSize+10 {
		t.Fatalf("the offset a client resumes from holds the partial segment: %d", got)
	}
	p, err = s.Receive(r, Chunk{Offset: SegmentSize + 10}, bytes.NewReader(data[SegmentSize+10:]))
	if err != nil || p.Finished == nil || p.Finished.Size != int64(len(data)) {
		t.Fatalf("last chunk: %+v %v", p, err)
	}
	r.State = "complete"
	rd, err := s.Blobs.Open(r)
	if err != nil {
		t.Fatal(err)
	}
	defer rd.Close()
	if got, _ := io.ReadAll(rd); !bytes.Equal(got, data) {
		t.Fatal("the file read back differs")
	}
}

func TestAChunkAtTheWrongOffsetIsRefusedWithTheRightOne(t *testing.T) {
	s := NewService(testBlobs(t))
	data := make([]byte, 5000)
	r := started(t, s, data, false)
	if _, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data[:1000])); err != nil {
		t.Fatal(err)
	}
	var off *OffsetError
	if _, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data[:1000])); !errors.As(err, &off) || off.Have != 1000 {
		t.Fatalf("got %v", err)
	}
}

func TestMoreBytesThanDeclaredStopTheUpload(t *testing.T) {
	s := NewService(testBlobs(t))
	data := make([]byte, 1000)
	r := started(t, s, data, false)
	_, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(make([]byte, 5000)))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v", err)
	}
}

func TestAnUploadResumesFromTheLastWholeSegmentAfterARestart(t *testing.T) {
	blobs := testBlobs(t)
	data := make([]byte, 2*SegmentSize+100)
	_, _ = rand.Read(data)
	first := NewService(blobs)
	r := started(t, first, data, false)
	p, err := first.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data[:SegmentSize+SegmentSize/2]))
	if err != nil || p.Committed != SegmentSize {
		t.Fatalf("%+v %v", p, err)
	}
	r.Committed = p.Committed   // what the database keeps
	second := NewService(blobs) // a new process: the partial segment in memory is gone
	if got := second.Offset(r); got != SegmentSize {
		t.Fatalf("the resume offset after a restart: %d", got)
	}
	p, err = second.Receive(r, Chunk{Offset: SegmentSize}, bytes.NewReader(data[SegmentSize:]))
	if err != nil || p.Finished == nil {
		t.Fatalf("%+v %v", p, err)
	}
	r.State = "complete"
	rd, err := blobs.Open(r)
	if err != nil {
		t.Fatal(err)
	}
	defer rd.Close()
	if got, _ := io.ReadAll(rd); !bytes.Equal(got, data) {
		t.Fatal("a resumed file differs")
	}
}

func TestALengthNotKnownAtTheStartEndsWithTheLastChunk(t *testing.T) {
	s := NewService(testBlobs(t))
	data := bytes.Repeat([]byte("voice"), 40000)
	r := started(t, s, data, true)
	sum := sha256.Sum256(data)
	half := len(data) / 2
	if p, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data[:half])); err != nil || p.Finished != nil {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Receive(r, Chunk{Offset: int64(half), Length: int64(half)}, bytes.NewReader(data[half:])); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("a wrong length: %v", err)
	}
	p, err := s.Receive(r, Chunk{Offset: int64(half), Length: int64(len(data)), Checksum: sum[:]}, bytes.NewReader(data[half:]))
	if err != nil || p.Finished == nil || p.Finished.Size != int64(len(data)) {
		t.Fatalf("%+v %v", p, err)
	}
}

func TestAWrongChecksumIsRefused(t *testing.T) {
	s := NewService(testBlobs(t))
	data := []byte("some bytes of a file")
	r := started(t, s, data, false)
	r.SHA256 = bytes.Repeat([]byte{9}, 32)
	if _, err := s.Receive(r, Chunk{Offset: 0}, bytes.NewReader(data)); !errors.Is(err, ErrChecksum) {
		t.Fatalf("got %v", err)
	}
}

func TestFourChunksOfOneIdentityAtOnceAndNoMore(t *testing.T) {
	s := NewService(testBlobs(t))
	for range MaxInFlight {
		if !s.Enter(7) {
			t.Fatal("refused too early")
		}
	}
	if s.Enter(7) {
		t.Fatal("a fifth chunk was taken")
	}
	s.Leave(7)
	if !s.Enter(7) {
		t.Fatal("a freed place was not given")
	}
	if !s.Enter(8) {
		t.Fatal("another identity was held up")
	}
}
