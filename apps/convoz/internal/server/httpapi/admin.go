package httpapi

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// NewAdminHandler serves the admin socket: break-glass actions that must never be an HTTP route.
// Who may connect is decided by the socket (mode 0600, and the peer uid), not here.
func NewAdminHandler(store *pdb.Store, clock platform.Clock, origin string, logger *log.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+wire.AdminBootstrapLink, func(w http.ResponseWriter, r *http.Request) {
		var in struct{}
		if !decode(w, r, &in) {
			return
		}
		now := clock.Now()
		var (
			token   string
			expires time.Time
		)
		err := store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			m := inTx(tx)
			var err error
			if token, expires, err = auth.MintBootstrapLink(ctx, m.auth, now); err != nil {
				return err
			}
			return audit.Write(ctx, m.audit, now, audit.Entry{Action: "bootstrap.created"})
		})
		if err != nil {
			logger.Printf("admin: bootstrap link failed: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal", "Could not make the link.")
			return
		}
		writeJSON(w, http.StatusOK, wire.BootstrapLink{Token: token, URL: origin + "/bootstrap#" + token, ExpiresAt: expires.UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "No such admin route.")
	})
	return mux
}
