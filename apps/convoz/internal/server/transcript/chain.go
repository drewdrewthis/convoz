package transcript

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
)

// maxAudio is the biggest note a chain reads into memory: the upload limit (upload.MaxSize; a module may not import another).
const maxAudio = 26214400

// ErrBadAudio means an engine refused the file itself (a 400, 413, 415 or 422). Another engine would refuse it too, so the chain stops
// and the transcript is not tried again.
var ErrBadAudio = errors.New("the engine refused the audio")

// step is one engine of a chain: it answers the words of the whole note.
type step struct {
	name string
	do   func(ctx context.Context, audio []byte, mime string) (string, error)
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
	var failures []string
	for _, s := range c.steps {
		text, err := s.do(ctx, data, mime)
		if err == nil {
			return text, s.name, nil
		}
		if ctx.Err() != nil || errors.Is(err, ErrBadAudio) {
			return "", "", fmt.Errorf("%s: %w", s.name, err)
		}
		failures = append(failures, s.name+": "+err.Error())
	}
	return "", "", errors.New("every engine failed: " + strings.Join(failures, "; "))
}
