package transcript

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript/db"
)

// None is the engine name that turns transcription off. It is the default.
const None = "none"

// Attempts is how many tries a transcript gets before it is marked failed (the column's check).
const Attempts = 5

// MaxText is the longest transcript stored, in bytes (the column's check is on characters: 16384).
const MaxText = 16384

// States of a transcript.
const (
	Pending = "pending"
	Done    = "done"
	Failed  = "failed"
)

// Engine turns audio into words. audio is the decrypted note, read once; mime is its sniffed type.
type Engine interface {
	Transcribe(ctx context.Context, audio io.Reader, mime string) (string, error)
}

var (
	enginesMu sync.RWMutex
	engines   = map[string]Engine{}
)

// Register makes an engine available under a name. A build adds its engines from an init function: the testhooks build adds "fake".
func Register(name string, e Engine) {
	enginesMu.Lock()
	engines[name] = e
	enginesMu.Unlock()
}

// Lookup finds the engine a setting names. ok is false for "none" and for a name no build registered.
func Lookup(name string) (Engine, bool) {
	enginesMu.RLock()
	defer enginesMu.RUnlock()
	e, ok := engines[name]
	return e, ok && name != None
}

var defaultEngine = None

// SetDefault names the engine a note gets while the workspace setting is still "none": the one the server was started with.
func SetDefault(name string) {
	enginesMu.Lock()
	defaultEngine = name
	enginesMu.Unlock()
}

// Default is the engine the server was started with, "none" when it has none.
func Default() string {
	enginesMu.RLock()
	defer enginesMu.RUnlock()
	return defaultEngine
}

// Attributing is an engine that says which engine of its own answered; the transcript stores that name.
type Attributing interface {
	TranscribeAs(ctx context.Context, audio io.Reader, mime string) (text, engine string, err error)
}

// ValidName reports whether s can be the value of the engine setting.
func ValidName(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// Enqueue makes a pending transcript for an upload, due now. A second call changes nothing.
func Enqueue(ctx context.Context, d pdb.DBTX, now time.Time, uploadID int64, engine string) error {
	return db.New(d).EnqueueTranscript(ctx, db.EnqueueTranscriptParams{UploadID: uploadID, Engine: sql.NullString{String: engine, Valid: true}, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}})
}

// Job is a transcript due for a try.
type Job struct {
	UploadID int64
	Engine   string
	Attempts int64
}

// Next returns the oldest transcript that is due. ok is false when none is.
func Next(ctx context.Context, d pdb.DBTX, now time.Time) (Job, bool, error) {
	r, err := db.New(d).NextTranscript(ctx, sql.NullInt64{Int64: now.UnixMilli(), Valid: true})
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	return Job{UploadID: r.UploadID, Engine: r.Engine.String, Attempts: r.Attempts}, err == nil, err
}

// Finish stores the words of a pending transcript and reports whether it was still pending.
func Finish(ctx context.Context, d pdb.DBTX, now time.Time, uploadID int64, engine, text string) error {
	if len(text) > MaxText {
		text = text[:MaxText]
	}
	return db.New(d).FinishTranscript(ctx, db.FinishTranscriptParams{UploadID: uploadID, Text: sql.NullString{String: text, Valid: true}, Engine: sql.NullString{String: engine, Valid: true}, Now: now.UnixMilli()})
}

// Backoff is the wait before the next try after a failed one: 5 s, then 20 s, 80 s, ... .
func Backoff(attempts int64) time.Duration { return 5 * time.Second << (2 * attempts) }

// GiveUp marks a transcript failed at once, for a note no engine will take.
func GiveUp(ctx context.Context, d pdb.DBTX, now time.Time, j Job) error {
	return db.New(d).FailTranscript(ctx, db.FailTranscriptParams{UploadID: j.UploadID, Now: now.UnixMilli()})
}

// Retry books another try after a failure, or marks the transcript failed after the last one. It reports whether it gave up.
func Retry(ctx context.Context, d pdb.DBTX, now time.Time, j Job) (gaveUp bool, err error) {
	q := db.New(d)
	if j.Attempts+1 >= Attempts {
		return true, q.FailTranscript(ctx, db.FailTranscriptParams{UploadID: j.UploadID, Now: now.UnixMilli()})
	}
	return false, q.RetryTranscript(ctx, db.RetryTranscriptParams{UploadID: j.UploadID, NextAttemptAt: sql.NullInt64{Int64: now.Add(Backoff(j.Attempts)).UnixMilli(), Valid: true}, Now: now.UnixMilli()})
}

// Of is a transcript as a reader sees it.
type Of struct {
	State    string
	Text     string
	Attempts int64 // tries made so far; each one that has not finished the transcript failed
}

// ForUploads reads the transcripts of the given uploads, by upload id.
func ForUploads(ctx context.Context, d pdb.DBTX, uploadIDs []int64) (map[int64]Of, error) {
	out := map[int64]Of{}
	if len(uploadIDs) == 0 {
		return out, nil
	}
	rows, err := db.New(d).TranscriptsOf(ctx, uploadIDs)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.UploadID] = Of{State: r.State, Text: r.Text.String, Attempts: r.Attempts}
	}
	return out, nil
}

// ErrNoEngine means the setting names an engine this build does not have.
var ErrNoEngine = fmt.Errorf("no such transcription engine")
