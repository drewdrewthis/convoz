package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// postMessage is POST /api/conversations/:id/messages. One transaction writes the message, the conversation's
// counters, the author's read cursor, one inbox item per other agent participant and the thin event (I-4, I-43).
// The author is always the caller (I-40): the body has no author field and an unknown field is a 400.
func (s *Server) postMessage(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.PostRequest
	if !decode(w, r, &in) {
		return
	}
	if !validClientID(in.ClientID) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	isAgent := c.p.SessionID != 0
	if isAgent {
		if c.lease.Scopes&auth.ScopePost == 0 {
			writeErr(w, http.StatusForbidden, "forbidden", "This machine may not post.")
			return
		}
		if !s.postLimit.Allow(strconv.FormatInt(who, 10), now) {
			w.Header().Set("Retry-After", "1")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many messages. Slow down.")
			return
		}
	}

	var (
		posted   message.Message
		replayed bool
		wake     []int64
		denied   bool
		missing  bool
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		_, found, err := conversation.Get(ctx, d, convID)
		if err != nil {
			return err
		}
		_, visible, err := canSee(ctx, d, c.p, convID)
		if err != nil {
			return err
		}
		switch {
		case !visible && (!found || isAgent):
			denied = true // an agent is told 403 whether or not the conversation exists
			return nil
		case !found:
			missing = true
			return nil
		}
		if posted, replayed, err = message.Post(ctx, d, now, message.Draft{
			Conversation: convID, Author: who, Session: c.p.SessionID, Device: c.dev.ID, ClientID: in.ClientID, Body: in.Body, Format: in.Format,
		}); err != nil || replayed {
			return err
		}
		prevMain, err := conversation.RecordMainPost(ctx, d, now, convID, posted.ID, posted.Body)
		if err != nil {
			return err
		}
		seq, err := event.Write(ctx, d, now, event.Entry{
			Type: "message.created", Actor: who, Session: c.p.SessionID, Conversation: convID, Message: posted.ID,
			IdemKey: "message.create:" + in.ClientID, Payload: map[string]any{"id": posted.ID, "kind": "text", "conversation_id": convID},
		})
		if err != nil {
			return err
		}
		if moved, err := readstate.MoveForOwnPost(ctx, d, now, who, convID, prevMain, posted.ID); err != nil {
			return err
		} else if moved {
			if _, err := event.Write(ctx, d, now, event.Entry{Type: "read.moved", Actor: who, Conversation: convID, Audience: who, Payload: map[string]any{"main_id": posted.ID}}); err != nil {
				return err
			}
		}
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		parts, err := conversation.Participants(ctx, d, convID)
		if err != nil {
			return err
		}
		for _, pt := range parts {
			if e := dir[pt.IdentityID]; e.Kind == "agent" && !e.Disabled && pt.IdentityID != who {
				if err := inbox.FanOut(ctx, d, now, pt.IdentityID, convID, posted.ID, seq); err != nil {
					return err
				}
				wake = append(wake, pt.IdentityID)
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, message.ErrEmpty), errors.Is(err, message.ErrTooLarge), errors.Is(err, message.ErrFormat):
		s.messageRefused(w, err)
	case errors.Is(err, message.ErrClientIDConflict):
		writeFieldErr(w, http.StatusConflict, "client_id_conflict", "client_id", "That client id was used for a different message.")
	case err != nil:
		s.internalError(w, r, err)
	case denied:
		writeErr(w, http.StatusForbidden, "forbidden", "You are not a participant of that conversation.")
	case missing:
		writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
	default:
		status := http.StatusCreated
		if replayed {
			status = http.StatusOK
		} else {
			s.Bus.Notify(wake...)
			if isAgent {
				s.publishWorking(r.Context(), who, convID, false)
			}
		}
		writeJSON(w, status, wire.PostResponse{ID: posted.ID, ConversationID: convID, CreatedAt: posted.CreatedAt})
	}
}

// messageRefused answers a message the module refused.
func (s *Server) messageRefused(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, message.ErrTooLarge):
		writeFieldErr(w, http.StatusBadRequest, "too_large", "body", "A message body has at most 16384 bytes.")
	case errors.Is(err, message.ErrFormat):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "format", "The format is markdown, markdownv2 or plain.")
	default:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "The message is empty.")
	}
}
