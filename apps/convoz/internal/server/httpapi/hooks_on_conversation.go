//go:build testhooks

package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

// The nightly maintenance on demand: the test moves the clock, then asks the server to run what a night would run.
func init() {
	moduleHooks = append(moduleHooks, func(mux *http.ServeMux, s *Server) {
		mux.HandleFunc("POST "+testroutes.Maintenance, func(w http.ResponseWriter, r *http.Request) {
			reply(w, s.Maintain(r.Context()), nil)
		})
	})
}
