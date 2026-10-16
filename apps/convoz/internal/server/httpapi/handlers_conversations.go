package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// listConversations is GET /api/conversations: latest activity first. The owner sees every conversation, an agent
// only those it takes part in.
func (s *Server) listConversations(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var list []conversation.Conversation
	if c.p.Role == "owner" {
		list, err = conversation.ListAll(ctx, d)
	} else {
		list, err = conversation.ListOf(ctx, d, c.p.Identity())
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]wire.Conversation, 0, len(list))
	for _, cv := range list {
		floor, ok, err := canSee(ctx, d, c.p, cv.ID)
		if err == nil && ok {
			var v wire.Conversation
			if v, err = conversationView(ctx, d, c.p, dir, cv, floor); err == nil {
				out = append(out, v)
			}
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": out})
}

// getConversation is GET /api/conversations/:id. A conversation the caller cannot see does not exist for it.
func (s *Server) getConversation(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	v, found, err := s.visibleView(ctx, d, c.p, id)
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !found:
		writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
	}
}

// visibleView is the list row of conversation id for p; found is false when it does not exist or p cannot see it.
func (s *Server) visibleView(ctx context.Context, d pdb.DBTX, p authz.Principal, id int64) (v wire.Conversation, found bool, err error) {
	cv, ok, err := conversation.Get(ctx, d, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	floor, ok, err := canSee(ctx, d, p, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return wire.Conversation{}, false, err
	}
	v, err = conversationView(ctx, d, p, dir, cv, floor)
	return v, err == nil, err
}

// maxNewParticipants leaves a place for the creator in the 20 a conversation holds.
const maxNewParticipants = conversation.MaxParticipants - 1

// createConversation is POST /api/conversations (the owner; an agent credential is refused by the route).
// The same client_id again answers 200 with the conversation it made (I-24).
func (s *Server) createConversation(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		ClientID     string   `json:"client_id"`
		Title        string   `json:"title"`
		Participants []string `json:"participants"`
	}
	if !decode(w, r, &in) {
		return
	}
	title := strings.TrimSpace(in.Title)
	switch {
	case !validClientID(in.ClientID):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	case title != "" && !conversation.ValidTitle(title):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "A title has 1 to 120 characters.")
		return
	case len(in.Participants) > maxNewParticipants:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "participants", "A conversation has at most 20 participants.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	idemKey := "conversation.create:" + in.ClientID
	sig := createSignature(title, in.Participants)
	var (
		view     wire.Conversation
		created  bool
		badName  bool
		conflict bool
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		if prior, found, err := event.FindIdem(ctx, d, who, idemKey); err != nil || found {
			if err != nil {
				return err
			}
			if !strings.Contains(prior.Payload, `"sig":"`+sig+`"`) {
				conflict = true
				return nil
			}
			cv, _, err := conversation.Get(ctx, d, prior.Conversation)
			if err != nil {
				return err
			}
			view, err = conversationView(ctx, d, c.p, dir, cv, 0)
			return err
		}
		var members []int64
		for _, handle := range in.Participants {
			a, found, err := identity.Lookup(ctx, d, strings.ToLower(handle))
			if err != nil {
				return err
			}
			if !found || a.Kind != "agent" || a.Disabled {
				badName = true
				return nil
			}
			members = append(members, a.ID)
		}
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: who, Title: title, Members: members})
		if err != nil {
			return err
		}
		parts, err := conversation.Participants(ctx, d, cv.ID)
		if err != nil {
			return err
		}
		for _, pt := range parts {
			if err := readstate.Create(ctx, d, now, pt.IdentityID, cv.ID, cv.LastMessageID); err != nil {
				return err
			}
		}
		if _, err := event.Write(ctx, d, now, event.Entry{Type: event.ConversationCreated, Actor: who, Conversation: cv.ID, IdemKey: idemKey, Payload: map[string]any{"id": cv.ID, "sig": sig}}); err != nil {
			return err
		}
		created = true
		view, err = conversationView(ctx, d, c.p, dir, cv, 0)
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case conflict:
		writeFieldErr(w, http.StatusConflict, "client_id_conflict", "client_id", "That client id was used for a different conversation.")
	case badName:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "participants", "Each participant must be the handle of an agent that is not disabled.")
	case created:
		s.Bus.Notify()
		writeJSON(w, http.StatusCreated, map[string]any{"conversation": view})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": view})
	}
}

// createSignature fingerprints a create request (title and the set of handles) so a replay of its client id with
// another title or other participants is a conflict (I-24). A hash keeps the event free of titles (I-23).
func createSignature(title string, handles []string) string {
	set := make([]string, 0, len(handles))
	for _, h := range handles {
		set = append(set, strings.ToLower(h))
	}
	slices.Sort(set)
	sum := sha256.Sum256([]byte(title + "\x00" + strings.Join(slices.Compact(set), "\x00")))
	return hex.EncodeToString(sum[:16])
}

// intParam reads a non-negative integer query parameter; it writes the 400 itself and reports false for junk.
func intParam(w http.ResponseWriter, r *http.Request, name string) (v int64, present, ok bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return 0, false, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", name, "That must be a whole number, 0 or more.")
		return 0, true, false
	}
	return n, true, true
}

// listMessages is GET /api/conversations/:id/messages: oldest first. after=N the oldest page past N, before=N the
// newest page before N, neither the newest page. Messages from before the caller joined are never shown.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	before, hasBefore, ok1 := intParam(w, r, "before")
	after, hasAfter, ok2 := intParam(w, r, "after")
	limit, _, ok3 := intParam(w, r, "limit")
	if !ok1 || !ok2 || !ok3 {
		return
	}
	ctx, d := r.Context(), s.reader()
	_, found, err := conversation.Get(ctx, d, id)
	var floor int64
	var visible bool
	if err == nil && found {
		floor, visible, err = canSee(ctx, d, c.p, id)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || !visible {
		writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
		return
	}
	seq, err := event.MaxSeq(ctx, d)
	var page []message.Message
	if err == nil {
		switch {
		case hasAfter:
			page, err = message.After(ctx, d, id, after, floor, int(limit))
		case hasBefore:
			page, err = message.Before(ctx, d, id, before, floor, int(limit))
		default:
			page, err = message.Newest(ctx, d, id, floor, int(limit))
		}
	}
	var dir directory
	if err == nil {
		dir, err = loadDirectory(ctx, d)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.MessagesResponse{Messages: make([]wire.Message, 0, len(page)), AsOfSeq: seq}
	for _, m := range page {
		out.Messages = append(out.Messages, dir.message(m))
	}
	writeJSON(w, http.StatusOK, out)
}

// markRead is POST /api/conversations/:id/read. The cursor only moves forward, and never past the newest main message.
func (s *Server) markRead(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.ReadRequest
	if !decode(w, r, &in) {
		return
	}
	if in.MainID < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "main_id", "main_id must be 0 or more.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	var visible, moved bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		cv, found, err := conversation.Get(ctx, d, id)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, id); err != nil || !visible {
			return err
		}
		if err := readstate.Create(ctx, d, now, who, id, 0); err != nil { // a viewer with no cursor yet (the owner in a chat it was not added to)
			return err
		}
		if moved, err = readstate.Move(ctx, d, now, who, id, min(in.MainID, cv.LastMainID)); err != nil || !moved {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: event.ReadMoved, Actor: who, Conversation: id, Audience: who, Payload: map[string]any{"main_id": min(in.MainID, cv.LastMainID)}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
	default:
		if moved {
			s.Bus.Notify()
		}
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}
