//go:build testhooks

package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

// registerTestHooks adds the /__test/ routes when the testhooks build is also switched on at run time.
// They sit behind the wall like every other route: the Host check applies, and the TCP listener is loopback.
func registerTestHooks(mux *http.ServeMux, s *Server) {
	if !platform.HooksEnabled() {
		return
	}
	store := s.Store
	var (
		codesMu sync.Mutex
		codes   []string
	)
	// The next device-flow user codes, in order; after those, random ones.
	s.userCodes = func() string {
		codesMu.Lock()
		defer codesMu.Unlock()
		if len(codes) == 0 {
			return auth.NewUserCode()
		}
		next := codes[0]
		codes = codes[1:]
		return next
	}
	mux.HandleFunc("POST "+testroutes.UserCodes, func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Codes []string }
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		for _, c := range in.Codes {
			if !userCodeShape.MatchString(c) {
				http.Error(w, "a user code looks like KQWD-MZTP", http.StatusBadRequest)
				return
			}
		}
		codesMu.Lock()
		codes = append([]string(nil), in.Codes...)
		codesMu.Unlock()
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST "+testroutes.KV, func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Key, Value string }
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Key == "" {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		err := store.Writer.Tx(r.Context(), func(ctx context.Context, tx *db.Tx) error {
			return db.New(tx.DBTX()).SetKV(ctx, db.SetKVParams{Key: in.Key, Value: sql.NullString{String: in.Value, Valid: true}})
		})
		reply(w, err, nil)
	})
	mux.HandleFunc("GET "+testroutes.KV, func(w http.ResponseWriter, r *http.Request) {
		v, err := db.New(store.Reader.SQL()).GetKV(r.Context(), r.URL.Query().Get("key"))
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		reply(w, err, map[string]string{"value": v.String})
	})
	mux.HandleFunc("POST "+testroutes.SchemaVersion, func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Version int }
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		reply(w, platform.SetSchemaVersion(r.Context(), store, in.Version), nil)
	})
	mux.HandleFunc("GET "+testroutes.SchemaVersion, func(w http.ResponseWriter, r *http.Request) {
		v, err := platform.SchemaVersion(r.Context(), store)
		reply(w, err, map[string]int{"version": v})
	})
	mux.HandleFunc("POST "+testroutes.Clock, func(w http.ResponseWriter, r *http.Request) {
		clock, ok := s.Clock.(*platform.TestClock)
		var in struct {
			AdvanceMs int64 `json:"advance_ms"`
			Freeze    bool  `json:"freeze"`
			Unfreeze  bool  `json:"unfreeze"`
		}
		if !ok || json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		if in.Freeze {
			clock.Freeze()
		}
		if in.AdvanceMs != 0 {
			clock.Advance(time.Duration(in.AdvanceMs) * time.Millisecond)
		}
		if in.Unfreeze {
			clock.Unfreeze()
		}
		reply(w, nil, nil)
	})
	mux.HandleFunc("GET "+testroutes.Routes, func(w http.ResponseWriter, _ *http.Request) {
		type row struct {
			Method  string `json:"method"`
			Pattern string `json:"pattern"`
			Auth    string `json:"auth"`
			// The rest is what the security matrix (e2e security.wp18) compares with the OpenAPI contract.
			Lease       bool   `json:"lease"`
			RefuseLease bool   `json:"refuse_lease"`
			Scope       string `json:"scope"`
			StepUp      string `json:"step_up"`
			Page        bool   `json:"page"`
			Hidden      bool   `json:"hidden"`
		}
		rows := make([]row, 0, len(Routes))
		for _, r := range Routes {
			rows = append(rows, row{r.Method, r.Pattern, r.Auth.String(), r.Lease, r.RefuseLease, r.Scope, r.StepUp, r.Page, r.Hidden})
		}
		reply(w, nil, map[string]any{"routes": rows})
	})
	for _, add := range moduleHooks {
		add(mux, s)
	}
}

// moduleHooks are the test hooks of the later modules (fake push service, fake transcriber, seed routes). Each module
// registers its own from hooks_on_<module>.go in an init function, so no work package edits this file; its route names
// go in testroutes/<module>.go, so the release guard probes them.
var moduleHooks []func(mux *http.ServeMux, s *Server)

var userCodeShape = regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`)

func reply(w http.ResponseWriter, err error, body any) {
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	if body == nil {
		body = map[string]bool{"ok": true}
	}
	_ = json.NewEncoder(w).Encode(body)
}
