//go:build testhooks

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

func init() {
	moduleHooks = append(moduleHooks, registerUploadHooks)
	transcript.Register("fake", fakeEngine)
}

// fake is the transcription engine of the test build: it reads the whole note, then answers the text the test set, or fails.
type fake struct {
	mu   sync.Mutex
	text string
	fail bool
}

var fakeEngine = &fake{text: "fake transcript"}

func (f *fake) Transcribe(_ context.Context, audio io.Reader, _ string) (string, error) {
	if _, err := io.Copy(io.Discard, audio); err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return "", errors.New("the fake engine was told to fail")
	}
	return f.text, nil
}

func registerUploadHooks(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("POST "+testroutes.Transcriber, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text string `json:"text"`
			Fail bool   `json:"fail"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		fakeEngine.mu.Lock()
		fakeEngine.text, fakeEngine.fail = in.Text, in.Fail
		fakeEngine.mu.Unlock()
		reply(w, nil, nil)
	})
}
