//go:build testhooks

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

func init() {
	moduleHooks = append(moduleHooks, registerUploadHooks)
	transcript.Register("fake", fakeEngine)
}

// fakeTranscriber is the transcription engine of the test build: it reads the whole note, then answers the text the test set, or fails.
// With a delay it takes that long on the server clock, so a scenario that says "the engine takes 30 seconds" moves the test clock
// instead of waiting.
type fakeTranscriber struct {
	mu    sync.Mutex
	text  string
	fail  bool
	delay time.Duration
	clock platform.Clock
}

var fakeEngine = &fakeTranscriber{text: "fake transcript"}

func (f *fakeTranscriber) Transcribe(ctx context.Context, audio io.Reader, _ string) (string, error) {
	if _, err := io.Copy(io.Discard, audio); err != nil {
		return "", err
	}
	f.mu.Lock()
	text, fail, delay, clock := f.text, f.fail, f.delay, f.clock
	f.mu.Unlock()
	if delay > 0 && clock != nil {
		started := clock.Now()
		for clock.Now().Sub(started) < delay {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	if fail {
		return "", errors.New("the fake engine was told to fail")
	}
	return text, nil
}

func registerUploadHooks(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("POST "+testroutes.Transcriber, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text    string `json:"text"`
			Fail    bool   `json:"fail"`
			DelayMs int64  `json:"delay_ms"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		fakeEngine.mu.Lock()
		fakeEngine.text, fakeEngine.fail, fakeEngine.delay, fakeEngine.clock = in.Text, in.Fail, time.Duration(in.DelayMs)*time.Millisecond, s.Clock
		fakeEngine.mu.Unlock()
		reply(w, nil, nil)
	})
}
