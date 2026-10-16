// Package httpapi builds the HTTP handler tree.
package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// NewMux returns the server's routes. Test routes are added only by the testhooks build.
func NewMux(store *db.Store) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	registerTestHooks(mux, store)
	return mux
}
