package httpapi

import (
	"context"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// threadToConversation is POST /api/conversations/:id/threads/:root/conversation: the owner turns the thread of message :root into a
// conversation of its own (issue 32; owner msgs 1591, 2356). The new conversation is titled by the root, holds the people of the one
// it came from, and keeps a link to the root. Nothing is moved or copied: the thread stays where it is. Asking again for the same
// root gives the conversation made the first time. Only the owner may do it; the route asks for the owner and so does this.
func (s *Server) threadToConversation(w http.ResponseWriter, r *http.Request, c *call) {
	if c.p.SessionID != 0 || c.p.Role != "owner" {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the owner can turn a thread into a conversation.")
		return
	}
	source, ok := pathID(w, r)
	if !ok {
		return
	}
	root, err := strconv.ParseInt(r.PathValue("root"), 10, 64)
	if err != nil || root <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_request", "That is not a message id.")
		return
	}
	var view wire.Conversation
	var created, notFound, notRoot bool
	err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		m, found, err := message.Get(ctx, d, root)
		switch {
		case err != nil:
			return err
		case !found || m.ConversationID != source:
			notFound = true
			return nil
		case m.ThreadRootID != 0 || m.Kind == "system":
			notRoot = true
			return nil
		}
		if prior, found, err := conversation.OriginFromMessage(ctx, d, root); err != nil || found {
			if err == nil {
				view, err = s.detailOf(ctx, d, c.p, prior.Conversation)
			}
			return err
		}
		view, err = s.makeFromThread(ctx, d, c.p, source, m)
		created = err == nil
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case notFound:
		writeErr(w, http.StatusNotFound, "not_found", "No such message in that conversation.")
	case notRoot:
		writeErr(w, http.StatusBadRequest, "invalid_request", "Only the first message of a thread can start a conversation.")
	case created:
		s.Bus.Notify()
		writeJSON(w, http.StatusCreated, map[string]any{"conversation": view})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": view})
	}
}

// makeFromThread writes the conversation for root m of conversation source, with the people active in source.
func (s *Server) makeFromThread(ctx context.Context, d pdb.DBTX, p authz.Principal, source int64, m message.Message) (wire.Conversation, error) {
	who, now := p.Identity(), s.Clock.Now()
	parts, err := conversation.Participants(ctx, d, source)
	if err != nil {
		return wire.Conversation{}, err
	}
	members := make([]int64, 0, len(parts))
	for _, pt := range parts {
		members = append(members, pt.IdentityID)
	}
	title := conversation.CleanTitle(conversation.AutoTitle(m.Body))
	cv, err := conversation.Create(ctx, d, now, conversation.New{By: who, Title: title, TitleBy: conversation.TitleHuman, Members: members})
	if err != nil {
		return wire.Conversation{}, err
	}
	if err := conversation.SetOrigin(ctx, d, now, cv.ID, source, m.ID); err != nil {
		return wire.Conversation{}, err
	}
	seats, err := conversation.Participants(ctx, d, cv.ID)
	if err != nil {
		return wire.Conversation{}, err
	}
	for _, pt := range seats {
		if err := readstate.Create(ctx, d, now, pt.IdentityID, cv.ID, cv.LastMessageID); err != nil {
			return wire.Conversation{}, err
		}
	}
	if _, err := event.Write(ctx, d, now, event.Entry{Type: event.ConversationCreated, Actor: who, Conversation: cv.ID, Payload: map[string]any{"id": cv.ID}}); err != nil {
		return wire.Conversation{}, err
	}
	return s.detailOf(ctx, d, p, cv.ID)
}

// detailOf is the detail view of conversation id for p, with the rail.
func (s *Server) detailOf(ctx context.Context, d pdb.DBTX, p authz.Principal, id int64) (wire.Conversation, error) {
	v, _, err := s.visibleDetail(ctx, d, p, id)
	return v, err
}

// originView is the link a conversation keeps to the thread it was made from; nil when it has none, or when p cannot read the
// conversation of the thread (the link would tell p its title).
func originView(ctx context.Context, d pdb.DBTX, p authz.Principal, conv int64) (*wire.Origin, error) {
	o, found, err := conversation.OriginOf(ctx, d, conv)
	if err != nil || !found {
		return nil, err
	}
	if _, ok, err := canRead(ctx, d, p, o.Source); err != nil || !ok {
		return nil, err
	}
	out := &wire.Origin{ConversationID: o.Source, MessageID: o.Message}
	if src, found, err := conversation.Get(ctx, d, o.Source); err != nil {
		return nil, err
	} else if found {
		out.ConversationTitle = src.Title
	}
	return out, nil
}
