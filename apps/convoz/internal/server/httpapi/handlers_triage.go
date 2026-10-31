package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// setTriage is PUT /api/agents/:id/triage {"on": bool}: the owner makes an agent a triage agent (reads every conversation and thread, posts in
// them as itself, adds and removes agents in any chat), or takes the right back. Owner said (msg 1217): "Triage agents, yeah, they can read
// all of it. They can message. They don't have to be in the conversation." It needs a fresh passkey check for this agent and
// writes an audit line; it posts nothing in any chat. The right is looked up per request, so a revoke bites on the next call.
func (s *Server) setTriage(w http.ResponseWriter, r *http.Request, c *call) {
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
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "identity.triage", &id, now); err != nil {
			return err
		}
		if who, found, err := identity.ByID(ctx, d, id); err != nil {
			return err
		} else if !found || who.Kind != "agent" || who.Disabled {
			return auth.ErrNoAgent
		}
		if _, err := identity.SetTriage(ctx, d, id, *in.On); err != nil {
			return err
		}
		action := "identity.triage.off"
		if *in.On {
			action = "identity.triage.on"
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
		writeJSON(w, http.StatusOK, map[string]any{"triage": *in.On})
	}
}

// waiting is GET /api/waiting: for an agent with the triage right, what waits on the owner in every conversation it can read. It
// refuses any other caller. Open asks, the owner's newest main-chat messages unanswered for inbox.UnansweredAfter, plan items that
// wait on the owner, and the owner's unread count per conversation. Threads are not scanned for unanswered messages.
func (s *Server) waiting(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	if granted, err := isTriage(ctx, d, c.p); err != nil {
		s.internalError(w, r, err)
		return
	} else if !granted {
		writeErr(w, http.StatusForbidden, "forbidden", "The owner has not made you a triage agent.")
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
	}
	if out.Unanswered, err = s.unanswered(ctx, d, owner.ID, list, dir, now, 0); err != nil {
		return out, err
	}
	waiting, err := ask.ForNow(ctx, d, askThreads{}, owner.ID, now, now.UnixMilli()) // nothing is answered after now, so only the open asks come back
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

// unanswered lists, one per conversation, the owner's newest main-chat message that is at least the reminder wait old and has no later answer.
// GET /api/waiting and GET /api/now both call it, so the two cannot drift. A maxAge above 0 drops older messages (Now only). Members are
// read only for a chat with no title: they are its fallback name.
func (s *Server) unanswered(ctx context.Context, d pdb.DBTX, ownerID int64, list []conversation.Conversation, dir directory, now time.Time, maxAge time.Duration) ([]wire.WaitingUnanswered, error) {
	out := []wire.WaitingUnanswered{}
	for _, cv := range list {
		last, found, err := message.NewestCountedInMain(ctx, d, cv.ID)
		if err != nil {
			return nil, err
		}
		age := now.UnixMilli() - last.CreatedAt
		if !found || last.AuthorID != ownerID || age < inbox.UnansweredAfter.Milliseconds() || (maxAge > 0 && age > maxAge.Milliseconds()) {
			continue
		}
		if answered, err := message.HasReplyFromOther(ctx, d, last.ID, ownerID); err != nil { // `convoz reply` answers in the thread, not the main chat
			return nil, err
		} else if answered {
			continue
		}
		title := wire.AskConversation{ID: cv.ID}
		if cv.Title != "" {
			title.Title = ptr(cv.Title)
		}
		entry := wire.WaitingUnanswered{Conversation: title, MessageID: last.ID, Excerpt: message.ReplyPreview(last.Body), CreatedAt: last.CreatedAt, AgeMS: age, Members: []string{}}
		if cv.Title == "" {
			members, err := conversation.Participants(ctx, d, cv.ID)
			if err != nil {
				return nil, err
			}
			for _, m := range members {
				if m.IdentityID != ownerID {
					entry.Members = append(entry.Members, dir.person(m.IdentityID).Handle)
				}
			}
		}
		out = append(out, entry)
	}
	return out, nil
}
