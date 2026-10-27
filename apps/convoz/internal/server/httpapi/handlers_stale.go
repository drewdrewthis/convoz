package httpapi

import (
	"context"
	"net/http"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// markStale is POST /api/conversations/:id/stale: an agent in the conversation says it is done for now, so the owner's rail folds it into
// Older at once (Drew, 2026-10-22). The owner may mark it too, from his voice call (features/call/writes.ts, convoz#43). The next
// message brings it back; nothing clears the mark. Only a participant may mark it, and not
// while the owner wrote the last message: that conversation waits on the agents, so it never goes stale (#42, Drew msg 2678). No
// system line is written: a line would be a message after the mark. The reason is kept with the mark and shown with the conversation.
func (s *Server) markStale(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Reason string `json:"reason"`
		Reopen bool   `json:"reopen"`
		Force  bool   `json:"force"`
	}
	if !decode(w, r, &in) {
		return
	}
	byOwner := c.p.SessionID == 0 && c.p.Role == "owner" // a guest or member (no session either) counts as an agent here
	if in.Reopen && !byOwner {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the owner may reopen a conversation.")
		return
	}
	reason := conversation.CleanTitle(in.Reason) // untrusted text: control and bidi characters go, as in an agent's title
	if utf8.RuneCountInString(reason) > conversation.MaxStaleReasonRunes {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "reason", "A reason has at most 200 characters.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	// The owner closing from the rail asks for it (force), so the owner-spoke-last guard does not bind him; the call's model and agents keep it.
	skipGuard := byOwner && (in.Force || in.Reopen)
	var visible, ownerLast bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		cv, found, err := conversation.Get(ctx, d, convID)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, convID); err != nil || !visible {
			return err
		}
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		if !skipGuard {
			if ownerLast, err = ownerWroteLast(ctx, d, dir, cv); err != nil || ownerLast {
				return err
			}
		}
		if in.Reopen && byOwner {
			err = conversation.ClearStale(ctx, d, convID)
		} else {
			err = conversation.MarkStale(ctx, d, now, convID, reason)
		}
		if err != nil {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: eventConversationChanged, Actor: who, Session: c.p.SessionID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	case ownerLast:
		writeErr(w, http.StatusConflict, "owner_spoke_last", "The owner wrote the last message, so the conversation waits on you. It cannot go stale.")
	default:
		s.writeDetail(w, r, c, convID)
	}
}
