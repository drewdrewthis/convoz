//go:build testhooks

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func init() { moduleHooks = append(moduleHooks, eventHooks) }

// seedBatch keeps each transaction small, so the log file stays small and the writer is not held for minutes.
const seedBatch = 50_000

// eventHooks registers the test route that fills a conversation with messages in bulk.
func eventHooks(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("POST "+testroutes.SeedMessages, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ConversationID int64 `json:"conversation_id"`
			Count          int   `json:"count"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.ConversationID <= 0 || in.Count <= 0 {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		cv, ok, err := conversation.Get(r.Context(), s.reader(), in.ConversationID)
		if err != nil || !ok {
			http.Error(w, "no such conversation", http.StatusNotFound)
			return
		}
		for left := in.Count; left > 0 && err == nil; left -= seedBatch {
			n := min(left, seedBatch)
			err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
				return message.Seed(ctx, tx.DBTX(), s.Clock.Now(), cv.ID, cv.CreatedBy, n)
			})
		}
		reply(w, err, nil)
	})
}
