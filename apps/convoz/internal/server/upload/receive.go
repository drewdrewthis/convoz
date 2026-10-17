package upload

import (
	"crypto/sha256"
	"errors"
	"io"
	"sync"
	"time"
)

// Service receives uploads. One lives per server.
type Service struct {
	Blobs *Blobs

	mu            sync.Mutex
	live          map[string]*liveUpload // by storage name: the partial segment of each upload in progress
	flying        map[int64]int          // chunks being received now, by identity
	machineBudget budget
}

// NewService makes the service over a blob directory.
func NewService(b *Blobs) *Service {
	return &Service{Blobs: b, live: map[string]*liveUpload{}, flying: map[int64]int{}, machineBudget: budget{used: map[int64][]spend{}, limit: QuotaMachineDay}}
}

// liveUpload is the memory of one upload: the key, the sealed segments and the bytes not yet a whole segment.
type liveUpload struct {
	mu       sync.Mutex
	key      []byte
	sealed   int64  // plaintext bytes in sealed segments
	segments uint64 // sealed segments
	buf      []byte // the partial segment, at most SegmentSize bytes between chunks
}

// budget counts the bytes a machine started in a day (design §13.1: 2 GB). It lives in memory.
type budget struct {
	mu    sync.Mutex
	used  map[int64][]spend
	limit int64
}

type spend struct {
	at    time.Time
	bytes int64
}

// take spends n bytes of the machine's day and reports whether the day had room for them.
func (b *budget) take(machine int64, now time.Time, n int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	var total int64
	keep := b.used[machine][:0]
	for _, s := range b.used[machine] {
		if now.Sub(s.at) < 24*time.Hour {
			keep = append(keep, s)
			total += s.bytes
		}
	}
	if total+n > b.limit {
		b.used[machine] = keep
		return false
	}
	b.used[machine] = append(keep, spend{now, n})
	return true
}

// liveOf finds or builds the memory of an upload from its row. A first sight after a restart cuts the file back to the whole
// segments the database counts.
func (s *Service) liveOf(r Row) (*liveUpload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l := s.live[r.StorageName]; l != nil {
		return l, nil
	}
	key, err := s.Blobs.unwrap(r.PublicID, r.KeyWrapped)
	if err != nil {
		return nil, err
	}
	l := &liveUpload{key: key, sealed: r.Committed, segments: uint64(r.Committed / SegmentSize)}
	if err := s.Blobs.truncateTo(r.StorageName, l.segments); err != nil {
		return nil, err
	}
	s.live[r.StorageName] = l
	return l, nil
}

// Remove forgets the memory of uploads and unlinks their sealed files (an upload that ended, expired or was deleted).
func (s *Service) Remove(storages ...string) {
	s.mu.Lock()
	for _, n := range storages {
		delete(s.live, n)
	}
	s.mu.Unlock()
	s.Blobs.Remove(storages...)
}

// Forget drops the memory of a finished upload; its file stays.
func (s *Service) Forget(storage string) {
	s.mu.Lock()
	delete(s.live, storage)
	s.mu.Unlock()
}

// Offset is where the next chunk must start: the sealed segments and the partial one in memory.
func (s *Service) Offset(r Row) int64 {
	if r.Complete() {
		return r.DeclaredSize
	}
	s.mu.Lock()
	l := s.live[r.StorageName]
	s.mu.Unlock()
	if l == nil {
		return r.Committed
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sealed + int64(len(l.buf))
}

// Enter counts a chunk of the identity as being received; it reports false at MaxInFlight. Leave ends it.
func (s *Service) Enter(identity int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flying[identity] >= MaxInFlight {
		return false
	}
	s.flying[identity]++
	return true
}

// Leave ends a chunk Enter counted.
func (s *Service) Leave(identity int64) {
	s.mu.Lock()
	s.flying[identity]--
	s.mu.Unlock()
}

// Chunk is what a PATCH says besides its bytes.
type Chunk struct {
	Offset int64
	// Length is the whole file's size, sent with the last chunk of an upload whose length was not known; 0 otherwise.
	Length int64
	// Checksum is the SHA-256 the finished file must have, when the length was not known at the start.
	Checksum   []byte
	DurationMS int64
	Waveform   []byte
}

// Finished is what a complete, checked file turned out to be.
type Finished struct {
	Kind, Mime    string
	Inline        bool
	Size          int64
	Width, Height int64
	DurationMS    int64
	Waveform      []byte
}

// Progress is where an upload stands after a chunk. Finished is set once the file is complete.
type Progress struct {
	Offset    int64 // where the next chunk starts
	Committed int64 // the bytes in sealed segments, which the database keeps
	Finished  *Finished
}

// Receive takes the bytes of one chunk. It seals every whole segment as it fills and keeps the rest in memory (I-27). A body that
// ends early (a dropped connection) keeps what arrived: the error comes back with the Progress so far.
func (s *Service) Receive(r Row, c Chunk, body io.Reader) (Progress, error) {
	if r.Complete() {
		return Progress{Offset: r.DeclaredSize, Committed: r.DeclaredSize}, ErrComplete
	}
	l, err := s.liveOf(r)
	if err != nil {
		return Progress{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	have := l.sealed + int64(len(l.buf))
	if c.Offset != have {
		return Progress{Offset: have, Committed: l.sealed}, &OffsetError{Have: have}
	}
	room := r.DeclaredSize - have // the cap counts the bytes streamed, whatever the client declared (I-31)
	if r.Deferred && c.Length > 0 {
		if c.Length <= have || c.Length > MaxSize {
			return Progress{Offset: have, Committed: l.sealed}, ErrBadRequest
		}
		room = c.Length - have // the length the client now gives is the cap too
	}
	_, rerr := l.take(s, r, body, room)
	progress := Progress{Offset: l.sealed + int64(len(l.buf)), Committed: l.sealed}
	if rerr != nil {
		return progress, rerr
	}
	total := progress.Offset
	done := total == r.DeclaredSize && !r.Deferred || r.Deferred && c.Length > 0 && total == c.Length
	if !done {
		return progress, nil
	}
	f, err := l.finish(s, r, c, total)
	progress.Committed, progress.Offset = total, total
	if err != nil {
		return progress, err
	}
	progress.Finished = f
	return progress, nil
}

// take reads the body into the partial segment, sealing a segment each time more than one fills. It reads at most room+1 bytes: the
// extra one proves the client sent more than it declared.
func (l *liveUpload) take(s *Service, r Row, body io.Reader, room int64) (int64, error) {
	var read int64
	tmp := make([]byte, 64<<10)
	src := io.LimitReader(body, room+1)
	for {
		n, err := src.Read(tmp)
		if n > 0 {
			read += int64(n)
			if read > room {
				return read, ErrTooLarge
			}
			l.buf = append(l.buf, tmp[:n]...)
			for len(l.buf) > SegmentSize { // the last segment is sealed only when the end is known
				if serr := s.Blobs.sealSegment(r.StorageName, l.key, r.PublicID, l.segments, l.buf[:SegmentSize], false); serr != nil {
					return read, serr
				}
				l.sealed += SegmentSize
				l.segments++
				l.buf = append(l.buf[:0], l.buf[SegmentSize:]...)
			}
		}
		if errors.Is(err, io.EOF) {
			return read, nil
		}
		if err != nil {
			return read, err
		}
	}
}

// finish seals the last segment, checks the file against its checksum and sniffs what it is.
func (l *liveUpload) finish(s *Service, r Row, c Chunk, total int64) (*Finished, error) {
	if len(l.buf) == 0 {
		return nil, ErrBadRequest
	}
	if err := s.Blobs.sealSegment(r.StorageName, l.key, r.PublicID, l.segments, l.buf, true); err != nil {
		return nil, err
	}
	l.sealed, l.segments, l.buf = total, l.segments+1, nil
	rd, err := s.Blobs.openWith(r.StorageName, l.key, r.PublicID, total)
	if err != nil {
		return nil, err
	}
	defer rd.Close()
	want := r.SHA256
	if r.Deferred {
		want = c.Checksum
	}
	if len(want) == 32 {
		h := sha256.New()
		if _, err := io.Copy(h, rd); err != nil {
			return nil, err
		}
		if string(h.Sum(nil)) != string(want) {
			return nil, ErrChecksum
		}
		if _, err := rd.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
	}
	info, err := sniff(rd, r.Kind)
	if err != nil {
		return nil, err
	}
	f := &Finished{Kind: info.Kind, Mime: info.Mime, Inline: info.Inline, Size: total, Width: info.Width, Height: info.Height}
	if f.Kind == KindAudio {
		f.DurationMS = min(max(c.DurationMS, 0), MaxDurationMS)
		if len(c.Waveform) <= MaxWaveform {
			f.Waveform = c.Waveform
		}
	}
	return f, nil
}
