//go:build testhooks

package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func adminEnabled() bool { return os.Getenv("CONVOZ_TEST_ADMIN") == "1" }

// TestMaxMigration caps migrations to simulate the previous release.
func TestMaxMigration() int {
	if !adminEnabled() {
		return 0
	}
	n, _ := strconv.Atoi(os.Getenv("CONVOZ_TEST_MAX_MIGRATION"))
	return n
}

func registerTestHooks(mux *http.ServeMux, db *platform.DB) {
	if !adminEnabled() {
		return
	}
	mux.HandleFunc("POST "+testroutes.KV, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Key, Value string }
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Key == "" {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		err := db.Exec("INSERT INTO system_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", in.Key, in.Value)
		reply(w, err, nil)
	}))
	mux.HandleFunc("GET "+testroutes.KV, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		v, found, err := db.QueryString("SELECT value FROM system_kv WHERE key=?", r.URL.Query().Get("key"))
		if err == nil && !found {
			http.NotFound(w, r)
			return
		}
		reply(w, err, map[string]string{"value": v})
	}))
	mux.HandleFunc("POST "+testroutes.SchemaVersion, loopbackOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Version int }
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		reply(w, db.SetSchemaVersion(in.Version), nil)
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
