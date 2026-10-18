package transcript

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"
	"unicode/utf8"
)

// maxAudio is the biggest note a chain reads into memory: the upload limit (upload.MaxSize; a module may not import another).
const maxAudio = 26214400

// ErrBadAudio means an engine refused the file itself (a 400, 413, 415 or 422). Another engine would refuse it too, so the chain stops
// and the transcript is not tried again.
var ErrBadAudio = errors.New("the engine refused the audio")

// Plausibility limits. A note over minDuration whose words come to fewer than minCharsPerSecond, or whose last segment ends more than
// maxTailGap before the note does, was probably cut short by the engine (a streamed webm has no duration header).
const (
	minDuration       = 15 * time.Second
	minCharsPerSecond = 1.5
	maxTailGap        = 10 * time.Second
)

type durationKey struct{}

// WithDuration tells the chain how long the note is, so it can tell an engine that stopped early from one that heard it all.
func WithDuration(ctx context.Context, ms int64) context.Context {
	return context.WithValue(ctx, durationKey{}, time.Duration(ms)*time.Millisecond)
}

// answer is what an engine heard: the words, and when its last segment ends (0 when the engine does not say).
type answer struct {
	text string
	end  time.Duration
}

// suspect reports whether the answer looks cut short for a note of the given length.
func (a answer) suspect(note time.Duration) bool {
	if note <= minDuration {
		return false
	}
	if float64(utf8.RuneCountInString(a.text)) < minCharsPerSecond*note.Seconds() {
		return true
	}
	return a.end > 0 && note-a.end > maxTailGap
}

// step is one engine of a chain: it answers the words of the whole note.
type step struct {
	name string
	do   func(ctx context.Context, audio []byte, mime string) (answer, error)
}

// Chain tries its engines in order. It falls to the next on a timeout, a 429, a 5xx, a network error or a refused key, and stops at
// the first answer or at a refused file.
type Chain struct{ steps []step }

// Names lists the engines of the chain in the order they are tried.
func (c *Chain) Names() []string {
	names := make([]string, len(c.steps))
	for i, s := range c.steps {
		names[i] = s.name
	}
	return names
}

// Transcribe is the Engine interface; TranscribeAs also says which engine answered.
func (c *Chain) Transcribe(ctx context.Context, audio io.Reader, mime string) (string, error) {
	text, _, err := c.TranscribeAs(ctx, audio, mime)
	return text, err
}

// TranscribeAs reads the note once, since every engine needs all of it, and returns the words with the name of the engine that gave them.
// Errors carry engine names and HTTP statuses only: never the audio, the words or a key.
func (c *Chain) TranscribeAs(ctx context.Context, audio io.Reader, mime string) (text, engine string, err error) {
	data, err := io.ReadAll(io.LimitReader(audio, maxAudio+1))
	if err != nil {
		return "", "", err
	}
	if len(data) > maxAudio {
		return "", "", fmt.Errorf("%w: the note is too big", ErrBadAudio)
	}
	note, _ := ctx.Value(durationKey{}).(time.Duration)
	var failures []string
	var best answer
	var bestName string
	for _, s := range c.steps {
		a, err := s.do(ctx, data, mime)
		if err == nil {
			if !a.suspect(note) {
				return a.text, s.name, nil
			}
			log.Printf("transcript: %s gave %d characters for a %ds note: suspect", s.name, len(a.text), int(note.Seconds()))
			if bestName == "" || len(a.text) > len(best.text) {
				best, bestName = a, s.name
			}
			continue
		}
		if ctx.Err() != nil || errors.Is(err, ErrBadAudio) {
			return "", "", fmt.Errorf("%s: %w", s.name, err)
		}
		failures = append(failures, s.name+": "+err.Error())
	}
	if bestName != "" { // every answer was suspect: the longest is the nearest to the whole note
		return best.text, bestName, nil
	}
	return "", "", errors.New("every engine failed: " + strings.Join(failures, "; "))
}
