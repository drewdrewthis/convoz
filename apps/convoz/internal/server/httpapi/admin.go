package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// NewAdminHandler serves the admin socket: break-glass actions that must never be an HTTP route.
// Who may connect is decided by the socket (mode 0600, and the peer uid), not here.
func NewAdminHandler(store *pdb.Store, clock platform.Clock, origin string, logger *log.Logger) http.Handler {
	return NewAdminHandlerFor(store, clock, origin, "", logger)
}

// NewAdminHandlerFor is NewAdminHandler for a server with an agents-only address: an invite made here tells its agent to connect there.
func NewAdminHandlerFor(store *pdb.Store, clock platform.Clock, origin, agentOrigin string, logger *log.Logger) http.Handler {
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
			d := tx.DBTX()
			var err error
			if token, expires, err = auth.MintBootstrapLink(ctx, d, now); err != nil {
				return err
			}
			return audit.Write(ctx, d, now, audit.Entry{Action: "bootstrap.created"})
		})
		if err != nil {
			logger.Printf("admin: bootstrap link failed: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal", "Could not make the link.")
			return
		}
		writeJSON(w, http.StatusOK, wire.BootstrapLink{Token: token, URL: origin + "/bootstrap#" + token, ExpiresAt: expires.UTC().Format(time.RFC3339)})
	})
	// An invite for the owner, made on the server's own box (`convoz invite` with no agent). The socket decides who may ask.
	mux.HandleFunc("POST "+wire.AdminInvites, func(w http.ResponseWriter, r *http.Request) {
		var in wire.CreateInviteRequest
		if !decode(w, r, &in) {
			return
		}
		owner, err := identity.Owner(r.Context(), store.Reader.SQL())
		if errors.Is(err, identity.ErrNotFound) {
			writeErr(w, http.StatusConflict, "no_owner", "Set up the owner first.")
			return
		}
		server := origin
		if agentOrigin != "" {
			server = agentOrigin
		}
		var out wire.Invite
		if err == nil {
			out, err = makeInvite(r.Context(), store, clock, auth.AuditEntry{Actor: owner.ID}, in, server)
		}
		switch {
		case inviteRefused(w, err):
		case err != nil:
			logger.Printf("admin: invite failed: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal", "Could not make the invite.")
		default:
			writeJSON(w, http.StatusCreated, wire.InviteAnswer{Invite: out})
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "No such admin route.")
	})
	return mux
}
