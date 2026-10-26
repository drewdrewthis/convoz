package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// putMentionSnooze is PUT /api/conversations/:id/mention-snooze: "Later" on a mention card of Now (issue 103). The card hides until
// `until`; a mention that arrives after this call shows it again at once. The snooze is the caller's own and changes no message.
func (s *Server) putMentionSnooze(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.MentionSnoozeRequest
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	if until := time.UnixMilli(in.Until); !until.After(now) || until.After(now.Add(ask.MaxSnooze)) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "until", "A Later ends within the next 31 days.")
		return
	}
	visible := false
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, seen, err := canSee(ctx, d, c.p, id); err != nil || !seen {
			return err
		}
		visible = true
		newest, err := message.NewestMessageID(ctx, d, id)
		if err != nil {
			return err
		}
		return prefs.SnoozeMentions(ctx, d, c.p.Identity(), id, in.Until, newest)
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	default:
		writeJSON(w, http.StatusOK, wire.MentionSnoozeResult{ConversationID: id, Until: in.Until})
	}
}
