package ops

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// File is one entry of an export archive.
type File struct {
	Name string
	Data []byte
}

// Zip packs files into a zip archive.
func Zip(files []File) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f.Name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(f.Data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ExportTTL is how long a finished export can be downloaded.
const ExportTTL = time.Hour

// Export job states.
const (
	ExportRunning = "running"
	ExportDone    = "done"
	ExportFailed  = "failed"
)

type exportJob struct {
	owner   int64
	state   string
	data    []byte
	expires time.Time
}

// Exports are the export jobs of one server. A finished archive is held in memory only: no plaintext copy of the
// owner's data ever touches the disk (I-27), and it is gone after ExportTTL or a restart. The zero value is ready.
type Exports struct {
	mu   sync.Mutex
	jobs map[string]*exportJob
}

// Start runs build in the background for owner and returns the job id.
func (e *Exports) Start(clock platform.Clock, owner int64, build func() ([]File, error)) (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id := hex.EncodeToString(raw)
	e.mu.Lock()
	if e.jobs == nil {
		e.jobs = map[string]*exportJob{}
	}
	e.sweep(clock.Now())
	job := &exportJob{owner: owner, state: ExportRunning, expires: clock.Now().Add(ExportTTL)}
	e.jobs[id] = job
	e.mu.Unlock()
	go func() {
		var data []byte
		files, err := build()
		if err == nil {
			data, err = Zip(files)
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		job.state, job.data = ExportDone, data
		if err != nil {
			job.state = ExportFailed
		}
	}()
	return id, nil
}

// Get answers for owner only: another identity's job does not exist for it. data is set once the job is done.
func (e *Exports) Get(clock platform.Clock, owner int64, id string) (state string, data []byte, found bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sweep(clock.Now())
	job, ok := e.jobs[id]
	if !ok || job.owner != owner {
		return "", nil, false
	}
	return job.state, job.data, true
}

// sweep forgets expired jobs. Callers hold e.mu.
func (e *Exports) sweep(now time.Time) {
	for id, j := range e.jobs {
		if now.After(j.expires) {
			delete(e.jobs, id)
		}
	}
}
