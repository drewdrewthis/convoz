package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
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
// only those it takes part in. ?deleted=1 lists the trash instead (the owner only).
func (s *Server) listConversations(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	trash := r.URL.Query().Get("deleted") == "1"
	if trash && c.p.Role != "owner" {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the owner sees the trash.")
		return
	}
	s.maintainSoon(ctx)
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var list []conversation.Conversation
	switch {
	case trash:
		list, err = conversation.Trash(ctx, d)
	case c.p.Role == "owner":
		list, err = conversation.ListAll(ctx, d)
	default:
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

// getConversation is GET /api/conversations/:id with the details. A conversation the caller cannot see does not exist
// for a person; an agent is told 403 whether or not it exists.
func (s *Server) getConversation(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	v, found, err := s.visibleDetail(ctx, d, c.p, id)
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !found:
		notVisible(w, c)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
	}
}

// notVisible answers a conversation the caller cannot see: 404 for a person, 403 for an agent (which must not learn
// whether the conversation exists).
func notVisible(w http.ResponseWriter, c *call) {
	if c.p.SessionID != 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "You are not a participant of that conversation.")
		return
	}
	writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
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

// visibleDetail is the detail view of conversation id for p; found is false when it does not exist or p cannot see it.
func (s *Server) visibleDetail(ctx context.Context, d pdb.DBTX, p authz.Principal, id int64) (v wire.Conversation, found bool, err error) {
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
	v, err = detailView(ctx, d, p, dir, cv, floor)
	return v, err == nil, err
}

// maxNewParticipants leaves a place for the creator in the 20 a conversation holds.
const maxNewParticipants = conversation.MaxParticipants - 1

// maxAgentConversationsPerDay is how many conversations one agent may start in 24 hours (design §2.3).
const maxAgentConversationsPerDay = 20

// createConversation is POST /api/conversations. The owner's participants are added at once; an agent's go pending
// until a human approves (I-17), and an agent may start at most 20 conversations a day.
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
	case !wire.ValidClientID(in.ClientID):
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
	isAgent := c.p.SessionID != 0
	if isAgent && c.lease.Scopes&auth.ScopePost == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "This machine may not post.")
		return
	}
	idemKey := "conversation.create:" + in.ClientID
	sig := createSignature(title, in.Participants)
	var (
		view     wire.Conversation
		created  bool
		badName  bool
		conflict bool
		capped   bool
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
		if isAgent {
			n, err := conversation.AgentCreatedSince(ctx, d, who, now.Add(-24*time.Hour))
			if err != nil {
				return err
			}
			if n >= maxAgentConversationsPerDay {
				capped = true
				return nil
			}
		}
		var members, listed []int64
		for _, handle := range in.Participants {
			a, found, err := identity.Lookup(ctx, d, strings.ToLower(handle))
			if err != nil {
				return err
			}
			if !found || a.Kind != "agent" || a.Disabled {
				badName = true
				return nil
			}
			switch {
			case a.ID == who:
			case isAgent:
				listed = append(listed, a.ID)
			default:
				members = append(members, a.ID)
			}
		}
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: who, Title: title, Members: members, Pending: listed})
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
	case capped:
		tooMany(w, time.Hour, "An agent may start 20 conversations a day.")
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
// thread=ID reads one thread instead: its root (a stub when the caller joined after it) and the replies the caller may see.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	before, hasBefore, ok1 := intParam(w, r, "before")
	after, hasAfter, ok2 := intParam(w, r, "after")
	limit, _, ok3 := intParam(w, r, "limit")
	root, hasThread, ok4 := intParam(w, r, "thread")
	if !ok1 || !ok2 || !ok3 || !ok4 {
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
		notVisible(w, c)
		return
	}
	if hasThread {
		if m, ok, err := message.Get(ctx, d, root); err != nil {
			s.internalError(w, r, err)
			return
		} else if !ok || m.ConversationID != id {
			writeErr(w, http.StatusNotFound, "not_found", "No such thread.")
			return
		}
	}
	seq, err := event.MaxSeq(ctx, d)
	var page []message.Message
	if err == nil {
		switch {
		case hasThread:
			page, err = message.Thread(ctx, d, id, root, floor, int(limit))
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
	var origins map[int64]wire.Origin
	if err == nil && c.p.SessionID == 0 {
		origins, err = originsOf(ctx, d, page)
	}
	var asks map[int64]string
	if err == nil {
		asks, err = asksOf(ctx, d, page)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.MessagesResponse{Messages: make([]wire.Message, 0, len(page)), AsOfSeq: seq}
	for _, m := range page {
		wm := dir.message(m)
		if o, ok := origins[m.ID]; ok {
			wm.Via = &o
		}
		if state, ok := asks[m.ID]; ok {
			wm.Kind, wm.Ask = "ask", &wire.AskState{State: state}
		}
		out.Messages = append(out.Messages, wm)
	}
	if hasThread {
		out.Messages = threadWithStub(out.Messages, root, floor)
	}
	writeJSON(w, http.StatusOK, out)
}

// threadStubWords stands in for a thread root the caller may not see (I-7).
const threadStubWords = "earlier message not shown"

// threadWithStub puts a stub for the root in front of the replies when the root is older than the caller's floor.
func threadWithStub(replies []wire.Message, root, floor int64) []wire.Message {
	if root > floor {
		return replies
	}
	stub := wire.Message{ID: root, Author: systemAuthor, Body: threadStubWords, Format: "plain"}
	return append([]wire.Message{stub}, replies...)
}

// asksOf finds where the asks in a page stand, by message id.
func asksOf(ctx context.Context, d pdb.DBTX, page []message.Message) (map[int64]string, error) {
	var ids []int64
	for _, m := range page {
		if m.Kind == "ask" {
			ids = append(ids, m.ID)
		}
	}
	return ask.States(ctx, d, ids)
}

// originsOf finds the session label and machine of the agent messages in a page, for the details a person opens.
func originsOf(ctx context.Context, d pdb.DBTX, page []message.Message) (map[int64]wire.Origin, error) {
	ids := make([]int64, 0, len(page))
	for _, m := range page {
		if m.Kind == "text" {
			ids = append(ids, m.ID)
		}
	}
	sessions, err := message.SessionsOf(ctx, d, ids)
	if err != nil || len(sessions) == 0 {
		return nil, err
	}
	out := make(map[int64]wire.Origin, len(sessions))
	known := map[int64]wire.Origin{}
	for msgID, sid := range sessions {
		o, seen := known[sid]
		if !seen {
			origin, ok, err := auth.OriginOf(ctx, d, sid)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			o = wire.Origin{Session: origin.Label, Machine: origin.Machine}
			known[sid] = o
		}
		out[msgID] = o
	}
	return out, nil
}

// markRead is POST /api/conversations/:id/read. The cursor only moves forward, and never past the newest main message.
// all=true marks the whole main thread read.
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
		target := min(in.MainID, cv.LastMainID)
		if in.All {
			target = cv.LastMainID
		}
		if moved, err = readstate.Move(ctx, d, now, who, id, target); err != nil || !moved {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: event.ReadMoved, Actor: who, Conversation: id, Audience: who, Payload: map[string]any{"main_id": target}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	default:
		if moved {
			s.Bus.Notify()
		}
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}
