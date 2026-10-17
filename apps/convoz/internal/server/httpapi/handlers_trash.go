package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
)

// answerChange ends a route that changes a conversation: 200 {}, or the "not there" answer when the transaction
// found nothing.
func (s *Server) answerChange(w http.ResponseWriter, r *http.Request, c *call, err error, found bool) {
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !found:
		notVisible(w, c)
	default:
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// patchConversation is PATCH /api/conversations/:id: the owner renames it or links its pull request. A chosen title is
// never changed by a later message.
func (s *Server) patchConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Title   *string `json:"title"`
		LinkURL *string `json:"link_url"`
	}
	if !decode(w, r, &in) {
		return
	}
	var title string
	if in.Title != nil {
		if title = strings.TrimSpace(*in.Title); !conversation.ValidTitle(title) {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "A title has 1 to 120 characters.")
			return
		}
	}
	if in.LinkURL != nil && *in.LinkURL != "" && !conversation.ValidLink(*in.LinkURL) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "link_url", "A link starts with https:// and has at most 500 characters.")
		return
	}
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, found, err = conversation.Get(ctx, d, convID); err != nil || !found {
			return err
		}
		if in.Title != nil {
			if err := conversation.Rename(ctx, d, convID, title); err != nil {
				return err
			}
		}
		if in.LinkURL != nil {
			if err := conversation.SetLink(ctx, d, convID, *in.LinkURL); err != nil {
				return err
			}
		}
		_, err = event.Write(ctx, d, s.Clock.Now(), event.Entry{Type: eventConversationChanged, Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	if err == nil && found {
		v, _, verr := s.visibleDetail(r.Context(), s.reader(), c.p, convID)
		if verr != nil {
			s.internalError(w, r, verr)
			return
		}
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
		return
	}
	s.answerChange(w, r, c, err, found)
}

// deleteConversation is DELETE /api/conversations/:id: the owner moves it to the trash for 30 days (I-49). Agents lose
// sight of it at once.
func (s *Server) deleteConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if found, err = conversation.Delete(ctx, d, now, convID, c.p.HumanID); err != nil || !found {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.deleted.v1", Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	s.answerChange(w, r, c, err, found)
}

// restoreConversation is POST /api/conversations/:id/restore: it comes back from the trash with all its messages.
func (s *Server) restoreConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if found, err = conversation.Restore(ctx, d, convID); err != nil || !found {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.restored.v1", Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	if err == nil && found {
		v, _, verr := s.visibleDetail(r.Context(), s.reader(), c.p, convID)
		if verr != nil {
			s.internalError(w, r, verr)
			return
		}
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
		return
	}
	s.answerChange(w, r, c, err, found)
}

// maintainEvery is how often a read of the list runs the clean-up jobs when no nightly run did.
const maintainEvery = time.Minute

// maintainSoon runs Maintain when a minute of server time passed since the last run, so the empty-conversation
// clean-up (24 h) and the trash purge (30 d) happen even if nothing else triggers them. A failure is logged only.
func (s *Server) maintainSoon(ctx context.Context) {
	// Serialised on purpose: a reader that lost a race for the run must not list before the winner's clean-up commits.
	s.maintaining.Lock()
	defer s.maintaining.Unlock()
	now := s.Clock.Now().UnixMilli()
	if now-s.maintainedAt.Load() < maintainEvery.Milliseconds() {
		return
	}
	s.maintainedAt.Store(now)
	if err := s.Maintain(ctx); err != nil {
		s.Log.Printf("maintenance: %v", err)
	}
}

// Maintain runs the nightly jobs of conversations (and wakes the snoozes whose time has come): it removes empty untitled conversations older than 24 hours (unless
// starred, I-20) and purges what has been in the trash for over 30 days (I-49). After a purge it empties the log, so
// no readable trace of the purged rows stays in the data files.
func (s *Server) Maintain(ctx context.Context) error {
	if err := s.wakeSnoozes(ctx); err != nil {
		return err
	}
	now := s.Clock.Now()
	var purged int64
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		starred := func(conv int64) (bool, error) { return prefs.StarredByAnyone(ctx, d, conv) }
		if _, err = conversation.CleanEmpty(ctx, d, now, starred); err != nil {
			return err
		}
		if purged, err = conversation.PurgeTrash(ctx, d, now); err != nil {
			return err
		}
		return inbox.Sweep(ctx, d, now)
	})
	if err == nil && purged > 0 {
		s.Bus.Notify()
		err = s.Store.Writer.CheckpointTruncate(ctx)
	}
	return err
}
