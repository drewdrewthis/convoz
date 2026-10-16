//go:build testhooks

package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func registerTestHooks(mux *http.ServeMux, store *db.Store) {
	if !platform.HooksEnabled() {
		return
	}
	mux.HandleFunc("POST "+testroutes.KV, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Key, Value string }
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Key == "" {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		err := store.Writer.Tx(r.Context(), func(ctx context.Context, tx *db.Tx) error {
			return db.New(tx.DBTX()).SetKV(r.Context(), db.SetKVParams{Key: in.Key, Value: sql.NullString{String: in.Value, Valid: true}})
		})
		reply(w, err, nil)
	}))
	mux.HandleFunc("GET "+testroutes.KV, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		v, err := db.New(store.Reader.SQL()).GetKV(r.Context(), r.URL.Query().Get("key"))
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		reply(w, err, map[string]string{"value": v.String})
	}))
	mux.HandleFunc("POST "+testroutes.SchemaVersion, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Version int }
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		reply(w, platform.SetSchemaVersion(r.Context(), store, in.Version), nil)
	}))
	mux.HandleFunc("GET "+testroutes.SchemaVersion, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		v, err := platform.SchemaVersion(r.Context(), store)
		reply(w, err, map[string]int{"version": v})
	}))
}

func loopbackOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
			http.NotFound(w, r)
			return
		}
		next(w, r)
	}
}

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
