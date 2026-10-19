//go:build testhooks

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func init() { moduleHooks = append(moduleHooks, registerVoiceHooks) }

// voiceAsk is what the fake token service of Google was asked.
type voiceAsk struct {
	Key  string          `json:"key"`
	Body json.RawMessage `json:"body"`
}

// registerVoiceHooks swaps Google's token service for a fake that records each request and answers a fixed token name (it starts with
// auth_tokens/, which the SDK needs to choose the constrained socket). POST {key} turns voice on with that key ("" turns it off); GET lists the requests.
func registerVoiceHooks(mux *http.ServeMux, s *Server) {
	var (
		mu    sync.Mutex
		asked = []voiceAsk{}
	)
	mint := func(_ context.Context, key string, body []byte) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		asked = append(asked, voiceAsk{Key: key, Body: body})
		return "auth_tokens/TESTONLY-ephemeral", nil
	}
	mux.HandleFunc("POST "+testroutes.Voice, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Key string `json:"key"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		s.setVoiceKey(in.Key, mint)
		reply(w, nil, nil)
	})
	mux.HandleFunc("GET "+testroutes.Voice, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		reply(w, nil, map[string]any{"requests": asked})
	})
}
