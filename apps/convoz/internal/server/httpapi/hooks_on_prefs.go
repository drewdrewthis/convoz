//go:build testhooks

package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func init() { moduleHooks = append(moduleHooks, prefsHooks) }

// prefsHooks registers the test route that reads the notification log.
func prefsHooks(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("GET "+testroutes.Notifications, func(w http.ResponseWriter, r *http.Request) {
		rows, err := notify.Log(r.Context(), s.reader())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type row struct {
			ID               int64  `json:"id"`
			IdentityID       int64  `json:"identity_id"`
			Reason           string `json:"reason"`
			Decision         string `json:"decision"`
			SuppressedReason string `json:"suppressed_reason"`
			ConversationID   int64  `json:"conversation_id"`
			MessageID        int64  `json:"message_id"`
		}
		out := make([]row, 0, len(rows))
		for _, l := range rows {
			out = append(out, row{l.ID, l.Identity, l.Reason, l.Decision, l.Why, l.Conversation, l.Message})
		}
		writeJSON(w, http.StatusOK, map[string]any{"notifications": out})
	})
}
