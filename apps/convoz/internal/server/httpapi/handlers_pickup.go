package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// openPickup is POST /api/conversations/:id/pickup/open: the owner offers the conversation to any agent that has the
// pickup scope (SEC-6).
func (s *Server) openPickup(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, found, err = conversation.Get(ctx, d, convID); err != nil || !found {
			return err
		}
		if err := conversation.OpenPickup(ctx, d, now, convID, c.p.HumanID); err != nil {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.pickup_opened.v1", Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	s.answerChange(w, r, c, err, found)
}

// pickupConversation is POST /api/conversations/:id/pickup: an agent with the pickup scope takes a conversation the
// owner opened. Only one wins (409 names who). It sees nothing from before the pickup (I-47). With {"fence": n} it
// instead renews the hold it has under that fence, and a stale fence is 409.
func (s *Server) pickupConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Fence int64 `json:"fence"`
	}
	if !decode(w, r, &in) {
		return
	}
	if c.lease.Scopes&auth.ScopePickup == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "This machine may not pick up conversations.")
		return
	}
	now, who := s.Clock.Now(), c.lease.IdentityID
	var (
		held   conversation.Assignment
		taken  conversation.TakenError
		failed error
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if in.Fence != 0 {
			failed = conversation.Renew(ctx, d, now, convID, who, in.Fence)
			return nil
		}
		cv, found, err := conversation.Get(ctx, d, convID)
		if err != nil {
			return err
		}
		if !found {
			failed = conversation.ErrNotOpen // an agent is told nothing more than "not open for pickup"
			return nil
		}
		if held, err = conversation.Pickup(ctx, d, now, convID, who, c.lease.SessionID); err != nil {
			failed = err
			return nil
		}
		line, seq, err := sayLine(ctx, d, now, who, convID, at(dirHandle(ctx, d, who))+" picked up this conversation", "pickup.taken", map[string]int64{"identity": who})
		if err != nil {
			return err
		}
		if _, err = conversation.Add(ctx, d, now, conversation.Join{Conversation: convID, Identity: who, By: who, Status: conversation.StatusActive, FloorID: line, Seq: seq}); err != nil {
			return err
		}
		if err := readstate.Create(ctx, d, now, who, convID, cv.LastMessageID); err != nil {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.picked_up.v1", Actor: who, Session: c.lease.SessionID, Conversation: convID, Payload: map[string]any{"conversation_id": convID, "agent": who}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case errors.As(failed, &taken):
		s.Bus.Notify()
		handle := dirHandle(r.Context(), s.reader(), taken.Agent)
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "already_picked_up", "message": at(handle) + " already picked up this conversation."}})
	case errors.Is(failed, conversation.ErrNotOpen):
		writeErr(w, http.StatusForbidden, "forbidden", "That conversation is not open for pickup.")
	case errors.Is(failed, conversation.ErrStaleFence):
		writeErr(w, http.StatusConflict, "stale_fence", "This pickup was released.")
	case failed != nil:
		s.internalError(w, r, failed)
	default:
		s.Bus.Notify(who)
		writeJSON(w, http.StatusOK, map[string]any{"conversation_id": convID, "fence": max(held.Fence, in.Fence)})
	}
}

// releaseEnded is the release every path that ends a lease runs in its transaction (I-38): the claims of the ended
// sessions let go, and so do their pickups, which leaves the conversations open for pickup again.
func releaseEnded(ctx context.Context, d pdb.DBTX, now time.Time, ended []int64) ([]inbox.Released, error) {
	if _, err := conversation.ReleaseSessions(ctx, d, ended); err != nil {
		return nil, err
	}
	return inbox.ReleaseSessions(ctx, d, now, ended)
}

// resumeConversation is POST /api/conversations/:id/resume: the owner lets paused agents post again (I-16).
func (s *Server) resumeConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, found, err = conversation.Get(ctx, d, convID); err != nil || !found {
			return err
		}
		resumed, err := conversation.HumanPosted(ctx, d, convID)
		if err != nil || !resumed {
			return err
		}
		_, _, err = sayLine(ctx, d, now, c.p.HumanID, convID, "Agents can post again.", "conversation.resumed", nil)
		return err
	})
	s.answerChange(w, r, c, err, found)
}
