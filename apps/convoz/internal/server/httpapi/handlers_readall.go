package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// setReadAll is PUT /api/agents/:id/read-all {"on": bool}: the owner lets an agent read every conversation and thread (and post in them
// as itself), or takes the right back. Owner said (msg 784): "I think I also want an option to tag or give an agent privileges to be
// able to monitor and review all conversations and threads without being added." It needs a fresh passkey check for this agent and
// writes an audit line; it posts nothing in any chat. The right is looked up per request, so a revoke bites on the next call.
func (s *Server) setReadAll(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		On *bool `json:"on"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.On == nil {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "on", "Say true or false.")
		return
	}
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "identity.read_all", &id, now); err != nil {
			return err
		}
		if who, found, err := identity.ByID(ctx, d, id); err != nil {
			return err
		} else if !found || who.Kind != "agent" || who.Disabled {
			return auth.ErrNoAgent
		}
		if _, err := identity.SetReadAll(ctx, d, id, *in.On); err != nil {
			return err
		}
		action := "identity.read_all.off"
		if *in.On {
			action = "identity.read_all.on"
		}
		return flowPorts.Journal.Audit(ctx, d, now, auth.AuditEntry{Actor: c.human.ID, Device: c.dev.ID, Action: action, TargetKind: "identity", TargetID: id})
	})
	switch {
	case errors.Is(err, auth.ErrStepUp):
		stepUpInvalid(w)
	case errors.Is(err, auth.ErrNoAgent):
		writeErr(w, http.StatusNotFound, "not_found", "No such enabled agent.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"read_all": *in.On})
	}
}

// waiting is GET /api/waiting: for an agent with the read-all right, what waits on the owner in every conversation it can read. It
// refuses any other caller. Open asks, the owner's newest main-chat messages unanswered for inbox.UnansweredAfter, plan items that
// wait on the owner, and the owner's unread count per conversation. Threads are not scanned for unanswered messages.
func (s *Server) waiting(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	if granted, err := readsAll(ctx, d, c.p); err != nil {
		s.internalError(w, r, err)
		return
	} else if !granted {
		writeErr(w, http.StatusForbidden, "forbidden", "The owner has not let you read all conversations.")
		return
	}
	out, err := s.waitingOn(ctx, d, c)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) waitingOn(ctx context.Context, d pdb.DBTX, c *call) (wire.WaitingResponse, error) {
	now := s.Clock.Now()
	out := wire.WaitingResponse{Now: now.UnixMilli(), Asks: []wire.WaitingAsk{}, Unanswered: []wire.WaitingUnanswered{}, Plans: []wire.NowWaiting{}, Unread: []wire.WaitingUnread{}}
	owner, err := identity.Owner(ctx, d)
	if err != nil {
		return out, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return out, err
	}
	list, err := conversation.ListAll(ctx, d)
	if err != nil {
		return out, err
	}
	titles := map[int64]wire.AskConversation{}
	for _, cv := range list {
		title := wire.AskConversation{ID: cv.ID}
		if cv.Title != "" {
			title.Title = ptr(cv.Title)
		}
		titles[cv.ID] = title
		unread, err := unreadOf(ctx, d, owner.ID, cv, 0)
		if err != nil {
			return out, err
		}
		if unread > 0 {
			out.Unread = append(out.Unread, wire.WaitingUnread{Conversation: title, Unread: unread})
		}
		last, found, err := message.NewestCountedInMain(ctx, d, cv.ID)
		if err != nil {
			return out, err
		}
		if age := now.UnixMilli() - last.CreatedAt; found && last.AuthorID == owner.ID && age >= inbox.UnansweredAfter.Milliseconds() {
			out.Unanswered = append(out.Unanswered, wire.WaitingUnanswered{
				Conversation: title, MessageID: last.ID, Excerpt: message.ReplyPreview(last.Body), CreatedAt: last.CreatedAt, AgeMS: age,
			})
		}
	}
	waiting, err := ask.ForNow(ctx, d, owner.ID, now, now.UnixMilli()) // nothing is answered after now, so only the open asks come back
	if err != nil {
		return out, err
	}
	for _, a := range slices.Concat(waiting.Open, waiting.Snoozed) {
		title, live := titles[a.ConversationID]
		if !live {
			continue
		}
		_, snoozed := waiting.Until[a.ID]
		out.Asks = append(out.Asks, wire.WaitingAsk{
			ID: a.ID, Conversation: title, Asker: dir.person(a.AskerID), Question: a.Question, Urgent: a.Urgent, Snoozed: snoozed,
			CreatedAt: a.CreatedAt, AgeMS: now.UnixMilli() - a.CreatedAt,
		})
	}
	out.Plans, err = s.waitingPlans(ctx, d, c, dir)
	return out, err
}
